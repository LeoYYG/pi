// Released under MIT license
// Copyright (c) 2009-2010 Dominic Baggott
// Copyright (c) 2009-2010 Ash Berlin
// Copyright (c) 2011 Christoph Dorn <christoph@christophdorn.com> (http://www.christophdorn.com)

/*jshint browser:true, devel:true */

(function( expose ) {

/**
 *  class Markdown
 *
 *  Markdown processing in Javascript done right. We have very particular views
 *  on what constitutes 'right' which include:
 *
 *  - produces well-formed HTML (this means that em and strong nesting is
 *    important)
 *
 *  - has an intermediate representation to allow processing of parsed data (We
 *    in fact have two, both as [JsonML]: a markdown tree and an HTML tree).
 *
 *  - is easily extensible to add new dialects without having to rewrite the
 *    entire parsing mechanics
 *
 *  - has a good test suite
 *
 *  This implementation fulfills all of these (except that the test suite could
 *  do with expanding to automatically run all the fixtures from other Markdown
 *  implementations.)
 *
 *  ##### Intermediate Representation
 *
 *  *TODO* Talk about this :) Its JsonML, but document the node names we use.
 *
 *  [JsonML]: http://jsonml.org/ "JSON Markup Language"
 **/
var Markdown = expose.Markdown = function(dialect) {
  switch (typeof dialect) {
    case "undefined":
      this.dialect = Markdown.dialects.Gruber;
      break;
    case "object":
      this.dialect = dialect;
      break;
    default:
      if ( dialect in Markdown.dialects ) {
        this.dialect = Markdown.dialects[dialect];
      }
      else {
        throw new Error("Unknown Markdown dialect '" + String(dialect) + "'");
      }
      break;
  }
  this.em_state = [];
  this.strong_state = [];
  this.debug_indent = "";
};

/**
 *  parse( markdown, [dialect] ) -> JsonML
 *  - markdown (String): markdown string to parse
 *  - dialect (String | Dialect): the dialect to use, defaults to gruber
 *
 *  Parse `markdown` and return a markdown document as a Markdown.JsonML tree.
 **/
expose.parse = function( source, dialect ) {
  // dialect will default if undefined
  var md = new Markdown( dialect );
  return md.toTree( source );
};

/**
 *  toHTML( markdown, [dialect]  ) -> String
 *  toHTML( md_tree ) -> String
 *  - markdown (String): markdown string to parse
 *  - md_tree (Markdown.JsonML): parsed markdown tree
 *
 *  Take markdown (either as a string or as a JsonML tree) and run it through
 *  [[toHTMLTree]] then turn it into a well-formated HTML fragment.
 **/
expose.toHTML = function toHTML( source , dialect , options ) {
  var input = expose.toHTMLTree( source , dialect , options );

  return expose.renderJsonML( input );
};

/**
 *  toHTMLTree( markdown, [dialect] ) -> JsonML
 *  toHTMLTree( md_tree ) -> JsonML
 *  - markdown (String): markdown string to parse
 *  - dialect (String | Dialect): the dialect to use, defaults to gruber
 *  - md_tree (Markdown.JsonML): parsed markdown tree
 *
 *  Turn markdown into HTML, represented as a JsonML tree. If a string is given
 *  to this function, it is first parsed into a markdown tree by calling
 *  [[parse]].
 **/
expose.toHTMLTree = function toHTMLTree( input, dialect , options ) {
  // convert string input to an MD tree
  if ( typeof input ==="string" ) input = this.parse( input, dialect );

  // Now convert the MD tree to an HTML tree

  // remove references from the tree
  var attrs = extract_attr( input ),
      refs = {};

  if ( attrs && attrs.references ) {
    refs = attrs.references;
  }

  var html = convert_tree_to_html( input, refs , options );
  merge_text_nodes( html );
  return html;
};

// For Spidermonkey based engines
function mk_block_toSource() {
  return "Markdown.mk_block( " +
          uneval(this.toString()) +
          ", " +
          uneval(this.trailing) +
          ", " +
          uneval(this.lineNumber) +
          " )";
}

// node
function mk_block_inspect() {
  var util = require("util");
  return "Markdown.mk_block( " +
          util.inspect(this.toString()) +
          ", " +
          util.inspect(this.trailing) +
          ", " +
          util.inspect(this.lineNumber) +
          " )";

}

var mk_block = Markdown.mk_block = function(block, trail, line) {
  // Be helpful for default case in tests.
  if ( arguments.length == 1 ) trail = "\n\n";

  var s = new String(block);
  s.trailing = trail;
  // To make it clear its not just a string
  s.inspect = mk_block_inspect;
  s.toSource = mk_block_toSource;

  if ( line != undefined )
    s.lineNumber = line;

  return s;
};

function count_lines( str ) {
  var n = 0, i = -1;
  while ( ( i = str.indexOf("\n", i + 1) ) !== -1 ) n++;
  return n;
}

// Internal - split source into rough blocks
Markdown.prototype.split_blocks = function splitBlocks( input, startLine ) {
  input = input.replace(/(\r\n|\n|\r)/g, "\n");
  // [\s\S] matches _anything_ (newline or space)
  // [^] is equivalent but doesn't work in IEs.
  var re = /([\s\S]+?)($|\n#|\n(?:\s*\n|$)+)/g,
      blocks = [],
      m;

  var line_no = 1;

  if ( ( m = /^(\s*\n)/.exec(input) ) != null ) {
    // skip (but count) leading blank lines
    line_no += count_lines( m[0] );
    re.lastIndex = m[0].length;
  }

  while ( ( m = re.exec(input) ) !== null ) {
    if (m[2] == "\n#") {
      m[2] = "\n";
      re.lastIndex--;
    }
    blocks.push( mk_block( m[1], m[2], line_no ) );
    line_no += count_lines( m[0] );
  }

  return blocks;
};

/**
 *  Markdown#processBlock( block, next ) -> undefined | [ JsonML, ... ]
 *  - block (String): the block to process
 *  - next (Array): the following blocks
 *
 * Process `block` and return an array of JsonML nodes representing `block`.
 *
 * It does this by asking each block level function in the dialect to process
 * the block until one can. Succesful handling is indicated by returning an
 * array (with zero or more JsonML nodes), failure by a false value.
 *
 * Blocks handlers are responsible for calling [[Markdown#processInline]]
 * themselves as appropriate.
 *
 * If the blocks were split incorrectly or adjacent blocks need collapsing you
 * can adjust `next` in place using shift/splice etc.
 *
 * If any of this default behaviour is not right for the dialect, you can
 * define a `__call__` method on the dialect that will get invoked to handle
 * the block processing.
 */
Markdown.prototype.processBlock = function processBlock( block, next ) {
  var cbs = this.dialect.block,
      ord = cbs.__order__;

  if ( "__call__" in cbs ) {
    return cbs.__call__.call(this, block, next);
  }

  for ( var i = 0; i < ord.length; i++ ) {
    //D:this.debug( "Testing", ord[i] );
    var res = cbs[ ord[i] ].call( this, block, next );
    if ( res ) {
      //D:this.debug("  matched");
      if ( !isArray(res) || ( res.length > 0 && !( isArray(res[0]) ) ) )
        this.debug(ord[i], "didn't return a proper array");
      //D:this.debug( "" );
      return res;
    }
  }

  // Uhoh! no match! Should we throw an error?
  return [];
};

Markdown.prototype.processInline = function processInline( block ) {
  return this.dialect.inline.__call__.call( this, String( block ) );
};

/**
 *  Markdown#toTree( source ) -> JsonML
 *  - source (String): markdown source to parse
 *
 *  Parse `source` into a JsonML tree representing the markdown document.
 **/
// custom_tree means set this.tree to `custom_tree` and restore old value on return
Markdown.prototype.toTree = function toTree( source, custom_root ) {
  var blocks = source instanceof Array ? source : this.split_blocks( source );

  // Make tree a member variable so its easier to mess with in extensions
  var old_tree = this.tree;
  try {
    this.tree = custom_root || this.tree || [ "markdown" ];

    blocks:
    while ( blocks.length ) {
      var b = this.processBlock( blocks.shift(), blocks );

      // Reference blocks and the like won't return any content
      if ( !b.length ) continue blocks;

      this.tree.push.apply( this.tree, b );
    }
    return this.tree;
  }
  finally {
    if ( custom_root ) {
      this.tree = old_tree;
    }
  }
};

// Noop by default
Markdown.prototype.debug = function () {
  var args = Array.prototype.slice.call( arguments);
  args.unshift(this.debug_indent);
  if ( typeof print !== "undefined" )
      print.apply( print, args );
  if ( typeof console !== "undefined" && typeof console.log !== "undefined" )
      console.log.apply( null, args );
}

Markdown.prototype.loop_re_over_block = function( re, block, cb ) {
  // Dont use /g regexps with this
  var m,
      b = block.valueOf();

  while ( b.length && (m = re.exec(b) ) != null ) {
    b = b.substr( m[0].length );
    cb.call(this, m);
  }
  return b;
};

/**
 * Markdown.dialects
 *
 * Namespace of built-in dialects.
 **/
Markdown.dialects = {};

/**
 * Markdown.dialects.Gruber
 *
 * The default dialect that follows the rules set out by John Gruber's
 * markdown.pl as closely as possible. Well actually we follow the behaviour of
 * that script which in some places is not exactly what the syntax web page
 * says.
 **/
Markdown.dialects.Gruber = {
  block: {
    atxHeader: function atxHeader( block, next ) {
      var m = block.match( /^(#{1,6})\s*(.*?)\s*#*\s*(?:\n|$)/ );

      if ( !m ) return undefined;

      var header = [ "header", { level: m[ 1 ].length } ];
      Array.prototype.push.apply(header, this.processInline(m[ 2 ]));

      if ( m[0].length < block.length )
        next.unshift( mk_block( block.substr( m[0].length ), block.trailing, block.lineNumber + 2 ) );

      return [ header ];
    },

    setextHeader: function setextHeader( block, next ) {
      var m = block.match( /^(.*)\n([-=])\2\2+(?:\n|$)/ );

      if ( !m ) return undefined;

      var level = ( m[ 2 ] === "=" ) ? 1 : 2;
      var header = [ "header", { level : level }, m[ 1 ] ];

      if ( m[0].length < block.length )
        next.unshift( mk_block( block.substr( m[0].length ), block.trailing, block.lineNumber + 2 ) );

      return [ header ];
    },

    code: function code( block, next ) {
      // |    Foo
      // |bar
      // should be a code block followed by a paragraph. Fun
      //
      // There might also be adjacent code block to merge.

      var ret = [],
          re = /^(?: {0,3}\t| {4})(.*)\n?/,
          lines;

      // 4 spaces + content
      if ( !block.match( re ) ) return undefined;

      block_search:
      do {
        // Now pull out the rest of the lines
        var b = this.loop_re_over_block(
                  re, block.valueOf(), function( m ) { ret.push( m[1] ); } );

        if ( b.length ) {
          // Case alluded to in first comment. push it back on as a new block
          next.unshift( mk_block(b, block.trailing) );
          break block_search;
        }
        else if ( next.length ) {
          // Check the next block - it might be code too
          if ( !next[0].match( re ) ) break block_search;

          // Pull how how many blanks lines follow - minus two to account for .join
          ret.push ( block.trailing.replace(/[^\n]/g, "").substring(2) );

          block = next.shift();
        }
        else {
          break block_search;
        }
      } while ( true );

      return [ [ "code_block", ret.join("\n") ] ];
    },

    horizRule: function horizRule( block, next ) {
      // this needs to find any hr in the block to handle abutting blocks
      var m = block.match( /^(?:([\s\S]*?)\n)?[ \t]*([-_*])(?:[ \t]*\2){2,}[ \t]*(?:\n([\s\S]*))?$/ );

      if ( !m ) {
        return undefined;
      }

      var jsonml = [ [ "hr" ] ];

      // if there's a leading abutting block, process it
      if ( m[ 1 ] ) {
        jsonml.unshift.apply( jsonml, this.processBlock( m[ 1 ], [] ) );
      }

      // if there's a trailing abutting block, stick it into next
      if ( m[ 3 ] ) {
        next.unshift( mk_block( m[ 3 ] ) );
      }

      return jsonml;
    },

    // There are two types of lists. Tight and loose. Tight lists have no whitespace
    // between the items (and result in text just in the <li>) and loose lists,
    // which have an empty line between list items, resulting in (one or more)
    // paragraphs inside the <li>.
    //
    // There are all sorts weird edge cases about the original markdown.pl's
    // handling of lists:
    //
    // * Nested lists are supposed to be indented by four chars per level. But
    //   if they aren't, you can get a nested list by indenting by less than
    //   four so long as the indent doesn't match an indent of an existing list
    //   item in the 'nest stack'.
    //
    // * The type of the list (bullet or number) is controlled just by the
    //    first item at the indent. Subsequent changes are ignored unless they
    //    are for nested lists
    //
    lists: (function( ) {
      // Use a closure to hide a few variables.
      var any_list = "[*+-]|\\d+\\.",
          bullet_list = /[*+-]/,
          number_list = /\d+\./,
          // Capture leading indent as it matters for determining nested lists.
          is_list_re = new RegExp( "^( {0,3})(" + any_list + ")[ \t]+" ),
          indent_re = "(?: {0,3}\\t| {4})";

      // TODO: Cache this regexp for certain depths.
      // Create a regexp suitable for matching an li for a given stack depth
      function regex_for_depth( depth ) {

        return new RegExp(
          // m[1] = indent, m[2] = list_type
          "(?:^(" + indent_re + "{0," + depth + "} {0,3})(" + any_list + ")\\s+)|" +
          // m[3] = cont
          "(^" + indent_re + "{0," + (depth-1) + "}[ ]{0,4})"
        );
      }
      function expand_tab( input ) {
        return input.replace( / {0,3}\t/g, "    " );
      }

      // Add inline content `inline` to `li`. inline comes from processInline
      // so is an array of content
      function add(li, loose, inline, nl) {
        if ( loose ) {
          li.push( [ "para" ].concat(inline) );
          return;
        }
        // Hmmm, should this be any block level element or just paras?
        var add_to = li[li.length -1] instanceof Array && li[li.length - 1][0] == "para"
                   ? li[li.length -1]
                   : li;

        // If there is already some content in this list, add the new line in
        if ( nl && li.length > 1 ) inline.unshift(nl);

        for ( var i = 0; i < inline.length; i++ ) {
          var what = inline[i],
              is_str = typeof what == "string";
          if ( is_str && add_to.length > 1 && typeof add_to[add_to.length-1] == "string" ) {
            add_to[ add_to.length-1 ] += what;
          }
          else {
            add_to.push( what );
          }
        }
      }

      // contained means have an indent greater than the current one. On
      // *every* line in the block
      function get_contained_blocks( depth, blocks ) {

        var re = new RegExp( "^(" + indent_re + "{" + depth + "}.*?\\n?)*$" ),
            replace = new RegExp("^" + indent_re + "{" + depth + "}", "gm"),
            ret = [];

        while ( blocks.length > 0 ) {
          if ( re.exec( blocks[0] ) ) {
            var b = blocks.shift(),
                // Now remove that indent
                x = b.replace( replace, "");

            ret.push( mk_block( x, b.trailing, b.lineNumber ) );
          }
          else {
            break;
          }
        }
        return ret;
      }

      // passed to stack.forEach to turn list items up the stack into paras
      function paragraphify(s, i, stack) {
        var list = s.list;
        var last_li = list[list.length-1];

        if ( last_li[1] instanceof Array && last_li[1][0] == "para" ) {
          return;
        }
        if ( i + 1 == stack.length ) {
          // Last stack frame
          // Keep the same array, but replace the contents
          last_li.push( ["para"].concat( last_li.splice(1, last_li.length - 1) ) );
        }
        else {
          var sublist = last_li.pop();
          last_li.push( ["para"].concat( last_li.splice(1, last_li.length - 1) ), sublist );
        }
      }

      // The matcher function
      return function( block, next ) {
        var m = block.match( is_list_re );
        if ( !m ) return undefined;

        function make_list( m ) {
          var list = bullet_list.exec( m[2] )
                   ? ["bulletlist"]
                   : ["numberlist"];

          stack.push( { list: list, indent: m[1] } );
          return list;
        }


        var stack = [], // Stack of lists for nesting.
            list = make_list( m ),
            last_li,
            loose = false,
            ret = [ stack[0].list ],
            i;

        // Loop to search over block looking for inner block elements and loose lists
        loose_search:
        while ( true ) {
          // Split into lines preserving new lines at end of line
          var lines = block.split( /(?=\n)/ );

          // We have to grab all lines for a li and call processInline on them
          // once as there are some inline things that can span lines.
          var li_accumulate = "";

          // Loop over the lines in this block looking for tight lists.
          tight_search:
          for ( var line_no = 0; line_no < lines.length; line_no++ ) {
            var nl = "",
                l = lines[line_no].replace(/^\n/, function(n) { nl = n; return ""; });

            // TODO: really should cache this
            var line_re = regex_for_depth( stack.length );

            m = l.match( line_re );
            //print( "line:", uneval(l), "\nline match:", uneval(m) );

            // We have a list item
            if ( m[1] !== undefined ) {
              // Process the previous list item, if any
              if ( li_accumulate.length ) {
                add( last_li, loose, this.processInline( li_accumulate ), nl );
                // Loose mode will have been dealt with. Reset it
                loose = false;
                li_accumulate = "";
              }

              m[1] = expand_tab( m[1] );
              var wanted_depth = Math.floor(m[1].length/4)+1;
              //print( "want:", wanted_depth, "stack:", stack.length);
              if ( wanted_depth > stack.length ) {
                // Deep enough for a nested list outright
                //print ( "new nested list" );
                list = make_list( m );
                last_li.push( list );
                last_li = list[1] = [ "listitem" ];
              }
              else {
                // We aren't deep enough to be strictly a new level. This is
                // where Md.pl goes nuts. If the indent matches a level in the
                // stack, put it there, else put it one deeper then the
                // wanted_depth deserves.
                var found = false;
                for ( i = 0; i < stack.length; i++ ) {
                  if ( stack[ i ].indent != m[1] ) continue;
                  list = stack[ i ].list;
                  stack.splice( i+1, stack.length - (i+1) );
                  found = true;
                  break;
                }

                if (!found) {
                  //print("not found. l:", uneval(l));
                  wanted_depth++;
                  if ( wanted_depth <= stack.length ) {
                    stack.splice(wanted_depth, stack.length - wanted_depth);
                    //print("Desired depth now", wanted_depth, "stack:", stack.length);
                    list = stack[wanted_depth-1].list;
                    //print("list:", uneval(list) );
                  }
                  else {
                    //print ("made new stack for messy indent");
                    list = make_list(m);
                    last_li.push(list);
                  }
                }

                //print( uneval(list), "last", list === stack[stack.length-1].list );
                last_li = [ "listitem" ];
                list.push(last_li);
              } // end depth of shenegains
              nl = "";
            }

            // Add content
            if ( l.length > m[0].length ) {
              li_accumulate += nl + l.substr( m[0].length );
            }
          } // tight_search

          if ( li_accumulate.length ) {
            add( last_li, loose, this.processInline( li_accumulate ), nl );
            // Loose mode will have been dealt with. Reset it
            loose = false;
            li_accumulate = "";
          }

          // Look at the next block - we might have a loose list. Or an extra
          // paragraph for the current li
          var contained = get_contained_blocks( stack.length, next );

          // Deal with code blocks or properly nested lists
          if ( contained.length > 0 ) {
            // Make sure all listitems up the stack are paragraphs
            forEach( stack, paragraphify, this);

            last_li.push.apply( last_li, this.toTree( contained, [] ) );
          }

          var next_block = next[0] && next[0].valueOf() || "";

          if ( next_block.match(is_list_re) || next_block.match( /^ / ) ) {
            block = next.shift();

            // Check for an HR following a list: features/lists/hr_abutting
            var hr = this.dialect.block.horizRule( block, next );

            if ( hr ) {
              ret.push.apply(ret, hr);
              break;
            }

            // Make sure all listitems up the stack are paragraphs
            forEach( stack, paragraphify, this);

            loose = true;
            continue loose_search;
          }
          break;
        } // loose_search

        return ret;
      };
    })(),

    blockquote: function blockquote( block, next ) {
      if ( !block.match( /^>/m ) )
        return undefined;

      var jsonml = [];

      // separate out the leading abutting block, if any. I.e. in this case:
      //
      //  a
      //  > b
      //
      if ( block[ 0 ] != ">" ) {
        var lines = block.split( /\n/ ),
            prev = [],
            line_no = block.lineNumber;

        // keep shifting lines until you find a crotchet
        while ( lines.length && lines[ 0 ][ 0 ] != ">" ) {
            prev.push( lines.shift() );
            line_no++;
        }

        var abutting = mk_block( prev.join( "\n" ), "\n", block.lineNumber );
        jsonml.push.apply( jsonml, this.processBlock( abutting, [] ) );
        // reassemble new block of just block quotes!
        block = mk_block( lines.join( "\n" ), block.trailing, line_no );
      }


      // if the next block is also a blockquote merge it in
      while ( next.length && next[ 0 ][ 0 ] == ">" ) {
        var b = next.shift();
        block = mk_block( block + block.trailing + b, b.trailing, block.lineNumber );
      }

      // Strip off the leading "> " and re-process as a block.
      var input = block.replace( /^> ?/gm, "" ),
          old_tree = this.tree,
          processedBlock = this.toTree( input, [ "blockquote" ] ),
          attr = extract_attr( processedBlock );

      // If any link references were found get rid of them
      if ( attr && attr.references ) {
        delete attr.references;
        // And then remove the attribute object if it's empty
        if ( isEmpty( attr ) ) {
          processedBlock.splice( 1, 1 );
        }
      }

      jsonml.push( processedBlock );
      return jsonml;
    },

    referenceDefn: function referenceDefn( block, next) {
      var re = /^\s*\[(.*?)\]:\s*(\S+)(?:\s+(?:(['"])(.*?)\3|\((.*?)\)))?\n?/;
      // interesting matches are [ , ref_id, url, , title, title ]

      if ( !block.match(re) )
        return undefined;

      // make an attribute node if it doesn't exist
      if ( !extract_attr( this.tree ) ) {
        this.tree.splice( 1, 0, {} );
      }

      var attrs = extract_attr( this.tree );

      // make a references hash if it doesn't exist
      if ( attrs.references === undefined ) {
        attrs.references = {};
      }

      var b = this.loop_re_over_block(re, block, function( m ) {

        if ( m[2] && m[2][0] == "<" && m[2][m[2].length-1] == ">" )
          m[2] = m[2].substring( 1, m[2].length - 1 );

        var ref = attrs.references[ m[1].toLowerCase() ] = {
          href: m[2]
        };

        if ( m[4] !== undefined )
          ref.title = m[4];
        else if ( m[5] !== undefined )
          ref.title = m[5];

      } );

      if ( b.length )
        next.unshift( mk_block( b, block.trailing ) );

      return [];
    },

    para: function para( block, next ) {
      // everything's a para!
      return [ ["para"].concat( this.processInline( block ) ) ];
    }
  }
};

Markdown.dialects.Gruber.inline = {

    __oneElement__: function oneElement( text, patterns_or_re, previous_nodes ) {
      var m,
          res,
          lastIndex = 0;

      patterns_or_re = patterns_or_re || this.dialect.inline.__patterns__;
      var re = new RegExp( "([\\s\\S]*?)(" + (patterns_or_re.source || patterns_or_re) + ")" );

      m = re.exec( text );
      if (!m) {
        // Just boring text
        return [ text.length, text ];
      }
      else if ( m[1] ) {
        // Some un-interesting text matched. Return that first
        return [ m[1].length, m[1] ];
      }

      var res;
      if ( m[2] in this.dialect.inline ) {
        res = this.dialect.inline[ m[2] ].call(
                  this,
                  text.substr( m.index ), m, previous_nodes || [] );
      }
      // Default for now to make dev easier. just slurp special and output it.
      res = res || [ m[2].length, m[2] ];
      return res;
    },

    __call__: function inline( text, patterns ) {

      var out = [],
          res;

      function add(x) {
        //D:self.debug("  adding output", uneval(x));
        if ( typeof x == "string" && typeof out[out.length-1] == "string" )
          out[ out.length-1 ] += x;
        else
          out.push(x);
      }

      while ( text.length > 0 ) {
        res = this.dialect.inline.__oneElement__.call(this, text, patterns, out );
        text = text.substr( res.shift() );
        forEach(res, add )
      }

      return out;
    },

    // These characters are intersting elsewhere, so have rules for them so that
    // chunks of plain text blocks don't include them
    "]": function () {},
    "}": function () {},

    __escape__ : /^\\[\\`\*_{}\[\]()#\+.!\-]/,

    "\\": function escaped( text ) {
      // [ length of input processed, node/children to add... ]
      // Only esacape: \ ` * _ { } [ ] ( ) # * + - . !
      if ( this.dialect.inline.__escape__.exec( text ) )
        return [ 2, text.charAt( 1 ) ];
      else
        // Not an esacpe
        return [ 1, "\\" ];
    },

    "![": function image( text ) {

      // Unlike images, alt text is plain text only. no other elements are
      // allowed in there

      // ![Alt text](/path/to/img.jpg "Optional title")
      //      1          2            3       4         <--- captures
      var m = text.match( /^!\[(.*?)\][ \t]*\([ \t]*([^")]*?)(?:[ \t]+(["'])(.*?)\3)?[ \t]*\)/ );

      if ( m ) {
        if ( m[2] && m[2][0] == "<" && m[2][m[2].length-1] == ">" )
          m[2] = m[2].substring( 1, m[2].length - 1 );

        m[2] = this.dialect.inline.__call__.call( this, m[2], /\\/ )[0];

        var attrs = { alt: m[1], href: m[2] || "" };
        if ( m[4] !== undefined)
          attrs.title = m[4];

        return [ m[0].length, [ "img", attrs ] ];
      }

      // ![Alt text][id]
      m = text.match( /^!\[(.*?)\][ \t]*\[(.*?)\]/ );

      if ( m ) {
        // We can't check if the reference is known here as it likely wont be
        // found till after. Check it in md tree->hmtl tree conversion
        return [ m[0].length, [ "img_ref", { alt: m[1], ref: m[2].toLowerCase(), original: m[0] } ] ];
      }

      // Just consume the '!['
      return [ 2, "![" ];
    },

    "[": function link( text ) {

      var orig = String(text);
      // Inline content is possible inside `link text`
      var res = Markdown.DialectHelpers.inline_until_char.call( this, text.substr(1), "]" );

      // No closing ']' found. Just consume the [
      if ( !res ) return [ 1, "[" ];

      var consumed = 1 + res[ 0 ],
          children = res[ 1 ],
          link,
          attrs;

      // At this point the first [...] has been parsed. See what follows to find
      // out which kind of link we are (reference or direct url)
      text = text.substr( consumed );

      // [link text](/path/to/img.jpg "Optional title")
      //                 1            2       3         <--- captures
      // This will capture up to the last paren in the block. We then pull
      // back based on if there a matching ones in the url
      //    ([here](/url/(test))
      // The parens have to be balanced
      var m = text.match( /^\s*\([ \t]*([^"']*)(?:[ \t]+(["'])(.*?)\2)?[ \t]*\)/ );
      if ( m ) {
        var url = m[1];
        consumed += m[0].length;

        if ( url && url[0] == "<" && url[url.length-1] == ">" )
          url = url.substring( 1, url.length - 1 );

        // If there is a title we don't have to worry about parens in the url
        if ( !m[3] ) {
          var open_parens = 1; // One open that isn't in the capture
          for ( var len = 0; len < url.length; len++ ) {
            switch ( url[len] ) {
            case "(":
              open_parens++;
              break;
            case ")":
              if ( --open_parens == 0) {
                consumed -= url.length - len;
                url = url.substring(0, len);
              }
              break;
            }
          }
        }

        // Process escapes only
        url = this.dialect.inline.__call__.call( this, url, /\\/ )[0];

        attrs = { href: url || "" };
        if ( m[3] !== undefined)
          attrs.title = m[3];

        link = [ "link", attrs ].concat( children );
        return [ consumed, link ];
      }

      // [Alt text][id]
      // [Alt text] [id]
      m = text.match( /^\s*\[(.*?)\]/ );

      if ( m ) {

        consumed += m[ 0 ].length;

        // [links][] uses links as its reference
        attrs = { ref: ( m[ 1 ] || String(children) ).toLowerCase(),  original: orig.substr( 0, consumed ) };

        link = [ "link_ref", attrs ].concat( children );

        // We can't check if the reference is known here as it likely wont be
        // found till after. Check it in md tree->hmtl tree conversion.
        // Store the original so that conversion can revert if the ref isn't found.
        return [ consumed, link ];
      }

      // [id]
      // Only if id is plain (no formatting.)
      if ( children.length == 1 && typeof children[0] == "string" ) {

        attrs = { ref: children[0].toLowerCase(),  original: orig.substr( 0, consumed ) };
        link = [ "link_ref", attrs, children[0] ];
        return [ consumed, link ];
      }

      // Just consume the "["
      return [ 1, "[" ];
    },


    "<": function autoLink( text ) {
      var m;

      if ( ( m = text.match( /^<(?:((https?|ftp|mailto):[^>]+)|(.*?@.*?\.[a-zA-Z]+))>/ ) ) != null ) {
        if ( m[3] ) {
          return [ m[0].length, [ "link", { href: "mailto:" + m[3] }, m[3] ] ];

        }
        else if ( m[2] == "mailto" ) {
          return [ m[0].length, [ "link", { href: m[1] }, m[1].substr("mailto:".length ) ] ];
        }
        else
          return [ m[0].length, [ "link", { href: m[1] }, m[1] ] ];
      }

      return [ 1, "<" ];
    },

    "`": function inlineCode( text ) {
      // Inline code block. as many backticks as you like to start it
      // Always skip over the opening ticks.
      var m = text.match( /(`+)(([\s\S]*?)\1)/ );

      if ( m && m[2] )
        return [ m[1].length + m[2].length, [ "inlinecode", m[3] ] ];
      else {
        // TODO: No matching end code found - warn!
        return [ 1, "`" ];
      }
    },

    "  \n": function lineBreak( text ) {
      return [ 3, [ "linebreak" ] ];
    }

};

// Meta Helper/generator method for em and strong handling
function strong_em( tag, md ) {

  var state_slot = tag + "_state",
      other_slot = tag == "strong" ? "em_state" : "strong_state";

  function CloseTag(len) {
    this.len_after = len;
    this.name = "close_" + md;
  }

  return function ( text, orig_match ) {

    if ( this[state_slot][0] == md ) {
      // Most recent em is of this type
      //D:this.debug("closing", md);
      this[state_slot].shift();

      // "Consume" everything to go back to the recrusion in the else-block below
      return[ text.length, new CloseTag(text.length-md.length) ];
    }
    else {
      // Store a clone of the em/strong states
      var other = this[other_slot].slice(),
          state = this[state_slot].slice();

      this[state_slot].unshift(md);

      //D:this.debug_indent += "  ";

      // Recurse
      var res = this.processInline( text.substr( md.length ) );
      //D:this.debug_indent = this.debug_indent.substr(2);

      var last = res[res.length - 1];

      //D:this.debug("processInline from", tag + ": ", uneval( res ) );

      var check = this[state_slot].shift();
      if ( last instanceof CloseTag ) {
        res.pop();
        // We matched! Huzzah.
        var consumed = text.length - last.len_after;
        return [ consumed, [ tag ].concat(res) ];
      }
      else {
        // Restore the state of the other kind. We might have mistakenly closed it.
        this[other_slot] = other;
        this[state_slot] = state;

        // We can't reuse the processed result as it could have wrong parsing contexts in it.
        return [ md.length, md ];
      }
    }
  }; // End returned function
}

Markdown.dialects.Gruber.inline["**"] = strong_em("strong", "**");
Markdown.dialects.Gruber.inline["__"] = strong_em("strong", "__");
Markdown.dialects.Gruber.inline["*"]  = strong_em("em", "*");
Markdown.dialects.Gruber.inline["_"]  = strong_em("em", "_");


// Build default order from insertion order.
Markdown.buildBlockOrder = function(d) {
  var ord = [];
  for ( var i in d ) {
    if ( i == "__order__" || i == "__call__" ) continue;
    ord.push( i );
  }
  d.__order__ = ord;
};

// Build patterns for inline matcher
Markdown.buildInlinePatterns = function(d) {
  var patterns = [];

  for ( var i in d ) {
    // __foo__ is reserved and not a pattern
    if ( i.match( /^__.*__$/) ) continue;
    var l = i.replace( /([\\.*+?|()\[\]{}])/g, "\\$1" )
             .replace( /\n/, "\\n" );
    patterns.push( i.length == 1 ? l : "(?:" + l + ")" );
  }

  patterns = patterns.join("|");
  d.__patterns__ = patterns;
  //print("patterns:", uneval( patterns ) );

  var fn = d.__call__;
  d.__call__ = function(text, pattern) {
    if ( pattern != undefined ) {
      return fn.call(this, text, pattern);
    }
    else
    {
      return fn.call(this, text, patterns);
    }
  };
};

Markdown.DialectHelpers = {};
Markdown.DialectHelpers.inline_until_char = function( text, want ) {
  var consumed = 0,
      nodes = [];

  while ( true ) {
    if ( text.charAt( consumed ) == want ) {
      // Found the character we were looking for
      consumed++;
      return [ consumed, nodes ];
    }

    if ( consumed >= text.length ) {
      // No closing char found. Abort.
      return null;
    }

    var res = this.dialect.inline.__oneElement__.call(this, text.substr( consumed ) );
    consumed += res[ 0 ];
    // Add any returned nodes.
    nodes.push.apply( nodes, res.slice( 1 ) );
  }
}

// Helper function to make sub-classing a dialect easier
Markdown.subclassDialect = function( d ) {
  function Block() {}
  Block.prototype = d.block;
  function Inline() {}
  Inline.prototype = d.inline;

  return { block: new Block(), inline: new Inline() };
};

Markdown.buildBlockOrder ( Markdown.dialects.Gruber.block );
Markdown.buildInlinePatterns( Markdown.dialects.Gruber.inline );

Markdown.dialects.Maruku = Markdown.subclassDialect( Markdown.dialects.Gruber );

Markdown.dialects.Maruku.processMetaHash = function processMetaHash( meta_string ) {
  var meta = split_meta_hash( meta_string ),
      attr = {};

  for ( var i = 0; i < meta.length; ++i ) {
    // id: #foo
    if ( /^#/.test( meta[ i ] ) ) {
      attr.id = meta[ i ].substring( 1 );
    }
    // class: .foo
    else if ( /^\./.test( meta[ i ] ) ) {
      // if class already exists, append the new one
      if ( attr["class"] ) {
        attr["class"] = attr["class"] + meta[ i ].replace( /./, " " );
      }
      else {
        attr["class"] = meta[ i ].substring( 1 );
      }
    }
    // attribute: foo=bar
    else if ( /\=/.test( meta[ i ] ) ) {
      var s = meta[ i ].split( /\=/ );
      attr[ s[ 0 ] ] = s[ 1 ];
    }
  }

  return attr;
}

function split_meta_hash( meta_string ) {
  var meta = meta_string.split( "" ),
      parts = [ "" ],
      in_quotes = false;

  while ( meta.length ) {
    var letter = meta.shift();
    switch ( letter ) {
      case " " :
        // if we're in a quoted section, keep it
        if ( in_quotes ) {
          parts[ parts.length - 1 ] += letter;
        }
        // otherwise make a new part
        else {
          parts.push( "" );
        }
        break;
      case "'" :
      case '"' :
        // reverse the quotes and move straight on
        in_quotes = !in_quotes;
        break;
      case "\\" :
        // shift off the next letter to be used straight away.
        // it was escaped so we'll keep it whatever it is
        letter = meta.shift();
      default :
        parts[ parts.length - 1 ] += letter;
        break;
    }
  }

  return parts;
}

Markdown.dialects.Maruku.block.document_meta = function document_meta( block, next ) {
  // we're only interested in the first block
  if ( block.lineNumber > 1 ) return undefined;

  // document_meta blocks consist of one or more lines of `Key: Value\n`
  if ( ! block.match( /^(?:\w+:.*\n)*\w+:.*$/ ) ) return undefined;

  // make an attribute node if it doesn't exist
  if ( !extract_attr( this.tree ) ) {
    this.tree.splice( 1, 0, {} );
  }

  var pairs = block.split( /\n/ );
  for ( p in pairs ) {
    var m = pairs[ p ].match( /(\w+):\s*(.*)$/ ),
        key = m[ 1 ].toLowerCase(),
        value = m[ 2 ];

    this.tree[ 1 ][ key ] = value;
  }

  // document_meta produces no content!
  return [];
};

Markdown.dialects.Maruku.block.block_meta = function block_meta( block, next ) {
  // check if the last line of the block is an meta hash
  var m = block.match( /(^|\n) {0,3}\{:\s*((?:\\\}|[^\}])*)\s*\}$/ );
  if ( !m ) return undefined;

  // process the meta hash
  var attr = this.dialect.processMetaHash( m[ 2 ] );

  var hash;

  // if we matched ^ then we need to apply meta to the previous block
  if ( m[ 1 ] === "" ) {
    var node = this.tree[ this.tree.length - 1 ];
    hash = extract_attr( node );

    // if the node is a string (rather than JsonML), bail
    if ( typeof node === "string" ) return undefined;

    // create the attribute hash if it doesn't exist
    if ( !hash ) {
      hash = {};
      node.splice( 1, 0, hash );
    }

    // add the attributes in
    for ( a in attr ) {
      hash[ a ] = attr[ a ];
    }

    // return nothing so the meta hash is removed
    return [];
  }

  // pull the meta hash off the block and process what's left
  var b = block.replace( /\n.*$/, "" ),
      result = this.processBlock( b, [] );

  // get or make the attributes hash
  hash = extract_attr( result[ 0 ] );
  if ( !hash ) {
    hash = {};
    result[ 0 ].splice( 1, 0, hash );
  }

  // attach the attributes to the block
  for ( a in attr ) {
    hash[ a ] = attr[ a ];
  }

  return result;
};

Markdown.dialects.Maruku.block.definition_list = function definition_list( block, next ) {
  // one or more terms followed by one or more definitions, in a single block
  var tight = /^((?:[^\s:].*\n)+):\s+([\s\S]+)$/,
      list = [ "dl" ],
      i, m;

  // see if we're dealing with a tight or loose block
  if ( ( m = block.match( tight ) ) ) {
    // pull subsequent tight DL blocks out of `next`
    var blocks = [ block ];
    while ( next.length && tight.exec( next[ 0 ] ) ) {
      blocks.push( next.shift() );
    }

    for ( var b = 0; b < blocks.length; ++b ) {
      var m = blocks[ b ].match( tight ),
          terms = m[ 1 ].replace( /\n$/, "" ).split( /\n/ ),
          defns = m[ 2 ].split( /\n:\s+/ );

      // print( uneval( m ) );

      for ( i = 0; i < terms.length; ++i ) {
        list.push( [ "dt", terms[ i ] ] );
      }

      for ( i = 0; i < defns.length; ++i ) {
        // run inline processing over the definition
        list.push( [ "dd" ].concat( this.processInline( defns[ i ].replace( /(\n)\s+/, "$1" ) ) ) );
      }
    }
  }
  else {
    return undefined;
  }

  return [ list ];
};

// splits on unescaped instances of @ch. If @ch is not a character the result
// can be unpredictable

Markdown.dialects.Maruku.block.table = function table (block, next) {

    var _split_on_unescaped = function(s, ch) {
        ch = ch || '\\s';
        if (ch.match(/^[\\|\[\]{}?*.+^$]$/)) { ch = '\\' + ch; }
        var res = [ ],
            r = new RegExp('^((?:\\\\.|[^\\\\' + ch + '])*)' + ch + '(.*)'),
            m;
        while(m = s.match(r)) {
            res.push(m[1]);
            s = m[2];
        }
        res.push(s);
        return res;
    }

    var leading_pipe = /^ {0,3}\|(.+)\n {0,3}\|\s*([\-:]+[\-| :]*)\n((?:\s*\|.*(?:\n|$))*)(?=\n|$)/,
        // find at least an unescaped pipe in each line
        no_leading_pipe = /^ {0,3}(\S(?:\\.|[^\\|])*\|.*)\n {0,3}([\-:]+\s*\|[\-| :]*)\n((?:(?:\\.|[^\\|])*\|.*(?:\n|$))*)(?=\n|$)/,
        i, m;
    if (m = block.match(leading_pipe)) {
        // remove leading pipes in contents
        // (header and horizontal rule already have the leading pipe left out)
        m[3] = m[3].replace(/^\s*\|/gm, '');
    } else if (! ( m = block.match(no_leading_pipe))) {
        return undefined;
    }

    var table = [ "table", [ "thead", [ "tr" ] ], [ "tbody" ] ];

    // remove trailing pipes, then split on pipes
    // (no escaped pipes are allowed in horizontal rule)
    m[2] = m[2].replace(/\|\s*$/, '').split('|');

    // process alignment
    var html_attrs = [ ];
    forEach (m[2], function (s) {
        if (s.match(/^\s*-+:\s*$/))       html_attrs.push({align: "right"});
        else if (s.match(/^\s*:-+\s*$/))  html_attrs.push({align: "left"});
        else if (s.match(/^\s*:-+:\s*$/)) html_attrs.push({align: "center"});
        else                              html_attrs.push({});
    });

    // now for the header, avoid escaped pipes
    m[1] = _split_on_unescaped(m[1].replace(/\|\s*$/, ''), '|');
    for (i = 0; i < m[1].length; i++) {
        table[1][1].push(['th', html_attrs[i] || {}].concat(
            this.processInline(m[1][i].trim())));
    }

    // now for body contents
    forEach (m[3].replace(/\|\s*$/mg, '').split('\n'), function (row) {
        var html_row = ['tr'];
        row = _split_on_unescaped(row, '|');
        for (i = 0; i < row.length; i++) {
            html_row.push(['td', html_attrs[i] || {}].concat(this.processInline(row[i].trim())));
        }
        table[2].push(html_row);
    }, this);

    return [table];
}

Markdown.dialects.Maruku.inline[ "{:" ] = function inline_meta( text, matches, out ) {
  if ( !out.length ) {
    return [ 2, "{:" ];
  }

  // get the preceeding element
  var before = out[ out.length - 1 ];

  if ( typeof before === "string" ) {
    return [ 2, "{:" ];
  }

  // match a meta hash
  var m = text.match( /^\{:\s*((?:\\\}|[^\}])*)\s*\}/ );

  // no match, false alarm
  if ( !m ) {
    return [ 2, "{:" ];
  }

  // attach the attributes to the preceeding element
  var meta = this.dialect.processMetaHash( m[ 1 ] ),
      attr = extract_attr( before );

  if ( !attr ) {
    attr = {};
    before.splice( 1, 0, attr );
  }

  for ( var k in meta ) {
    attr[ k ] = meta[ k ];
  }

  // cut out the string and replace it with nothing
  return [ m[ 0 ].length, "" ];
};

Markdown.dialects.Maruku.inline.__escape__ = /^\\[\\`\*_{}\[\]()#\+.!\-|:]/;

Markdown.buildBlockOrder ( Markdown.dialects.Maruku.block );
Markdown.buildInlinePatterns( Markdown.dialects.Maruku.inline );

var isArray = Array.isArray || function(obj) {
  return Object.prototype.toString.call(obj) == "[object Array]";
};

var forEach;
// Don't mess with Array.prototype. Its not friendly
if ( Array.prototype.forEach ) {
  forEach = function( arr, cb, thisp ) {
    return arr.forEach( cb, thisp );
  };
}
else {
  forEach = function(arr, cb, thisp) {
    for (var i = 0; i < arr.length; i++) {
      cb.call(thisp || arr, arr[i], i, arr);
    }
  }
}

var isEmpty = function( obj ) {
  for ( var key in obj ) {
    if ( hasOwnProperty.call( obj, key ) ) {
      return false;
    }
  }

  return true;
}

function extract_attr( jsonml ) {
  return isArray(jsonml)
      && jsonml.length > 1
      && typeof jsonml[ 1 ] === "object"
      && !( isArray(jsonml[ 1 ]) )
      ? jsonml[ 1 ]
      : undefined;
}



/**
 *  renderJsonML( jsonml[, options] ) -> String
 *  - jsonml (Array): JsonML array to render to XML
 *  - options (Object): options
 *
 *  Converts the given JsonML into well-formed XML.
 *
 *  The options currently understood are:
 *
 *  - root (Boolean): wether or not the root node should be included in the
 *    output, or just its children. The default `false` is to not include the
 *    root itself.
 */
expose.renderJsonML = function( jsonml, options ) {
  options = options || {};
  // include the root element in the rendered output?
  options.root = options.root || false;

  var content = [];

  if ( options.root ) {
    content.push( render_tree( jsonml ) );
  }
  else {
    jsonml.shift(); // get rid of the tag
    if ( jsonml.length && typeof jsonml[ 0 ] === "object" && !( jsonml[ 0 ] instanceof Array ) ) {
      jsonml.shift(); // get rid of the attributes
    }

    while ( jsonml.length ) {
      content.push( render_tree( jsonml.shift() ) );
    }
  }

  return content.join( "\n\n" );
};

function escapeHTML( text ) {
  return text.replace( /&/g, "&amp;" )
             .replace( /</g, "&lt;" )
             .replace( />/g, "&gt;" )
             .replace( /"/g, "&quot;" )
             .replace( /'/g, "&#39;" );
}

function render_tree( jsonml ) {
  // basic case
  if ( typeof jsonml === "string" ) {
    return escapeHTML( jsonml );
  }

  var tag = jsonml.shift(),
      attributes = {},
      content = [];

  if ( jsonml.length && typeof jsonml[ 0 ] === "object" && !( jsonml[ 0 ] instanceof Array ) ) {
    attributes = jsonml.shift();
  }

  while ( jsonml.length ) {
    content.push( render_tree( jsonml.shift() ) );
  }

  var tag_attrs = "";
  for ( var a in attributes ) {
    tag_attrs += " " + a + '="' + escapeHTML( attributes[ a ] ) + '"';
  }

  // be careful about adding whitespace here for inline elements
  if ( tag == "img" || tag == "br" || tag == "hr" ) {
    return "<"+ tag + tag_attrs + "/>";
  }
  else {
    return "<"+ tag + tag_attrs + ">" + content.join( "" ) + "</" + tag + ">";
  }
}

function convert_tree_to_html( tree, references, options ) {
  var i;
  options = options || {};

  // shallow clone
  var jsonml = tree.slice( 0 );

  if ( typeof options.preprocessTreeNode === "function" ) {
      jsonml = options.preprocessTreeNode(jsonml, references);
  }

  // Clone attributes if they exist
  var attrs = extract_attr( jsonml );
  if ( attrs ) {
    jsonml[ 1 ] = {};
    for ( i in attrs ) {
      jsonml[ 1 ][ i ] = attrs[ i ];
    }
    attrs = jsonml[ 1 ];
  }

  // basic case
  if ( typeof jsonml === "string" ) {
    return jsonml;
  }

  // convert this node
  switch ( jsonml[ 0 ] ) {
    case "header":
      jsonml[ 0 ] = "h" + jsonml[ 1 ].level;
      delete jsonml[ 1 ].level;
      break;
    case "bulletlist":
      jsonml[ 0 ] = "ul";
      break;
    case "numberlist":
      jsonml[ 0 ] = "ol";
      break;
    case "listitem":
      jsonml[ 0 ] = "li";
      break;
    case "para":
      jsonml[ 0 ] = "p";
      break;
    case "markdown":
      jsonml[ 0 ] = "html";
      if ( attrs ) delete attrs.references;
      break;
    case "code_block":
      jsonml[ 0 ] = "pre";
      i = attrs ? 2 : 1;
      var code = [ "code" ];
      code.push.apply( code, jsonml.splice( i, jsonml.length - i ) );
      jsonml[ i ] = code;
      break;
    case "inlinecode":
      jsonml[ 0 ] = "code";
      break;
    case "img":
      jsonml[ 1 ].src = jsonml[ 1 ].href;
      delete jsonml[ 1 ].href;
      break;
    case "linebreak":
      jsonml[ 0 ] = "br";
    break;
    case "link":
      jsonml[ 0 ] = "a";
      break;
    case "link_ref":
      jsonml[ 0 ] = "a";

      // grab this ref and clean up the attribute node
      var ref = references[ attrs.ref ];

      // if the reference exists, make the link
      if ( ref ) {
        delete attrs.ref;

        // add in the href and title, if present
        attrs.href = ref.href;
        if ( ref.title ) {
          attrs.title = ref.title;
        }

        // get rid of the unneeded original text
        delete attrs.original;
      }
      // the reference doesn't exist, so revert to plain text
      else {
        return attrs.original;
      }
      break;
    case "img_ref":
      jsonml[ 0 ] = "img";

      // grab this ref and clean up the attribute node
      var ref = references[ attrs.ref ];

      // if the reference exists, make the link
      if ( ref ) {
        delete attrs.ref;

        // add in the href and title, if present
        attrs.src = ref.href;
        if ( ref.title ) {
          attrs.title = ref.title;
        }

        // get rid of the unneeded original text
        delete attrs.original;
      }
      // the reference doesn't exist, so revert to plain text
      else {
        return attrs.original;
      }
      break;
  }

  // convert all the children
  i = 1;

  // deal with the attribute node, if it exists
  if ( attrs ) {
    // if there are keys, skip over it
    for ( var key in jsonml[ 1 ] ) {
        i = 2;
        break;
    }
    // if there aren't, remove it
    if ( i === 1 ) {
      jsonml.splice( i, 1 );
    }
  }

  for ( ; i < jsonml.length; ++i ) {
    jsonml[ i ] = convert_tree_to_html( jsonml[ i ], references, options );
  }

  return jsonml;
}


// merges adjacent text nodes into a single node
function merge_text_nodes( jsonml ) {
  // skip the tag name and attribute hash
  var i = extract_attr( jsonml ) ? 2 : 1;

  while ( i < jsonml.length ) {
    // if it's a string check the next item too
    if ( typeof jsonml[ i ] === "string" ) {
      if ( i + 1 < jsonml.length && typeof jsonml[ i + 1 ] === "string" ) {
        // merge the second string into the first and remove it
        jsonml[ i ] += jsonml.splice( i + 1, 1 )[ 0 ];
      }
      else {
        ++i;
      }
    }
    // if it's not a string recurse
    else {
      merge_text_nodes( jsonml[ i ] );
      ++i;
    }
  }
}

} )( (function() {
  if ( typeof exports === "undefined" ) {
    window.markdown = {};
    return window.markdown;
  }
  else {
    return exports;
  }
} )() );

//Copy from http://getbootstrap.com/customize/ for bootstrap custom
var __less = {"alerts.less":"//\n// Alerts\n// --------------------------------------------------\n\n\n// Base styles\n// -------------------------\n\n.alert {\n  padding: @alert-padding;\n  margin-bottom: @line-height-computed;\n  border: 1px solid transparent;\n  border-radius: @alert-border-radius;\n\n  // Headings for larger alerts\n  h4 {\n    margin-top: 0;\n    // Specified for the h4 to prevent conflicts of changing @headings-color\n    color: inherit;\n  }\n  // Provide class for links that match alerts\n  .alert-link {\n    font-weight: @alert-link-font-weight;\n  }\n\n  // Improve alignment and spacing of inner content\n  > p,\n  > ul {\n    margin-bottom: 0;\n  }\n  > p + p {\n    margin-top: 5px;\n  }\n}\n\n// Dismissable alerts\n//\n// Expand the right padding and account for the close button's positioning.\n\n.alert-dismissable {\n padding-right: (@alert-padding + 20);\n\n  // Adjust close link position\n  .close {\n    position: relative;\n    top: -2px;\n    right: -21px;\n    color: inherit;\n  }\n}\n\n// Alternate styles\n//\n// Generate contextual modifier classes for colorizing the alert.\n\n.alert-success {\n  .alert-variant(@alert-success-bg; @alert-success-border; @alert-success-text);\n}\n.alert-info {\n  .alert-variant(@alert-info-bg; @alert-info-border; @alert-info-text);\n}\n.alert-warning {\n  .alert-variant(@alert-warning-bg; @alert-warning-border; @alert-warning-text);\n}\n.alert-danger {\n  .alert-variant(@alert-danger-bg; @alert-danger-border; @alert-danger-text);\n}\n","badges.less":"//\n// Badges\n// --------------------------------------------------\n\n\n// Base classes\n.badge {\n  display: inline-block;\n  min-width: 10px;\n  padding: 3px 7px;\n  font-size: @font-size-small;\n  font-weight: @badge-font-weight;\n  color: @badge-color;\n  line-height: @badge-line-height;\n  vertical-align: baseline;\n  white-space: nowrap;\n  text-align: center;\n  background-color: @badge-bg;\n  border-radius: @badge-border-radius;\n\n  // Empty badges collapse automatically (not available in IE8)\n  &:empty {\n    display: none;\n  }\n\n  // Quick fix for badges in buttons\n  .btn & {\n    position: relative;\n    top: -1px;\n  }\n  .btn-xs & {\n    top: 0;\n    padding: 1px 5px;\n  }\n}\n\n// Hover state, but only for links\na.badge {\n  &:hover,\n  &:focus {\n    color: @badge-link-hover-color;\n    text-decoration: none;\n    cursor: pointer;\n  }\n}\n\n// Account for counters in navs\na.list-group-item.active > .badge,\n.nav-pills > .active > a > .badge {\n  color: @badge-active-color;\n  background-color: @badge-active-bg;\n}\n.nav-pills > li > a > .badge {\n  margin-left: 3px;\n}\n","bootstrap.less":"// Core variables and mixins\n@import \"variables.less\";\n@import \"mixins.less\";\n\n// Reset\n@import \"normalize.less\";\n@import \"print.less\";\n\n// Core CSS\n@import \"scaffolding.less\";\n@import \"type.less\";\n@import \"code.less\";\n@import \"grid.less\";\n@import \"tables.less\";\n@import \"forms.less\";\n@import \"buttons.less\";\n\n// Components\n@import \"component-animations.less\";\n@import \"glyphicons.less\";\n@import \"dropdowns.less\";\n@import \"button-groups.less\";\n@import \"input-groups.less\";\n@import \"navs.less\";\n@import \"navbar.less\";\n@import \"breadcrumbs.less\";\n@import \"pagination.less\";\n@import \"pager.less\";\n@import \"labels.less\";\n@import \"badges.less\";\n@import \"jumbotron.less\";\n@import \"thumbnails.less\";\n@import \"alerts.less\";\n@import \"progress-bars.less\";\n@import \"media.less\";\n@import \"list-group.less\";\n@import \"panels.less\";\n@import \"wells.less\";\n@import \"close.less\";\n\n// Components w/ JavaScript\n@import \"modals.less\";\n@import \"tooltip.less\";\n@import \"popovers.less\";\n@import \"carousel.less\";\n\n// Utility classes\n@import \"utilities.less\";\n@import \"responsive-utilities.less\";\n","breadcrumbs.less":"//\n// Breadcrumbs\n// --------------------------------------------------\n\n\n.breadcrumb {\n  padding: @breadcrumb-padding-vertical @breadcrumb-padding-horizontal;\n  margin-bottom: @line-height-computed;\n  list-style: none;\n  background-color: @breadcrumb-bg;\n  border-radius: @border-radius-base;\n\n  > li {\n    display: inline-block;\n\n    + li:before {\n      content: \"@{breadcrumb-separator}\\00a0\"; // Unicode space added since inline-block means non-collapsing white-space\n      padding: 0 5px;\n      color: @breadcrumb-color;\n    }\n  }\n\n  > .active {\n    color: @breadcrumb-active-color;\n  }\n}\n","button-groups.less":"//\n// Button groups\n// --------------------------------------------------\n\n// Make the div behave like a button\n.btn-group,\n.btn-group-vertical {\n  position: relative;\n  display: inline-block;\n  vertical-align: middle; // match .btn alignment given font-size hack above\n  > .btn {\n    position: relative;\n    float: left;\n    // Bring the \"active\" button to the front\n    &:hover,\n    &:focus,\n    &:active,\n    &.active {\n      z-index: 2;\n    }\n    &:focus {\n      // Remove focus outline when dropdown JS adds it after closing the menu\n      outline: none;\n    }\n  }\n}\n\n// Prevent double borders when buttons are next to each other\n.btn-group {\n  .btn + .btn,\n  .btn + .btn-group,\n  .btn-group + .btn,\n  .btn-group + .btn-group {\n    margin-left: -1px;\n  }\n}\n\n// Optional: Group multiple button groups together for a toolbar\n.btn-toolbar {\n  margin-left: -5px; // Offset the first child's margin\n  &:extend(.clearfix all);\n\n  .btn-group,\n  .input-group {\n    float: left;\n  }\n  > .btn,\n  > .btn-group,\n  > .input-group {\n    margin-left: 5px;\n  }\n}\n\n.btn-group > .btn:not(:first-child):not(:last-child):not(.dropdown-toggle) {\n  border-radius: 0;\n}\n\n// Set corners individual because sometimes a single button can be in a .btn-group and we need :first-child and :last-child to both match\n.btn-group > .btn:first-child {\n  margin-left: 0;\n  &:not(:last-child):not(.dropdown-toggle) {\n    .border-right-radius(0);\n  }\n}\n// Need .dropdown-toggle since :last-child doesn't apply given a .dropdown-menu immediately after it\n.btn-group > .btn:last-child:not(:first-child),\n.btn-group > .dropdown-toggle:not(:first-child) {\n  .border-left-radius(0);\n}\n\n// Custom edits for including btn-groups within btn-groups (useful for including dropdown buttons within a btn-group)\n.btn-group > .btn-group {\n  float: left;\n}\n.btn-group > .btn-group:not(:first-child):not(:last-child) > .btn {\n  border-radius: 0;\n}\n.btn-group > .btn-group:first-child {\n  > .btn:last-child,\n  > .dropdown-toggle {\n    .border-right-radius(0);\n  }\n}\n.btn-group > .btn-group:last-child > .btn:first-child {\n  .border-left-radius(0);\n}\n\n// On active and open, don't show outline\n.btn-group .dropdown-toggle:active,\n.btn-group.open .dropdown-toggle {\n  outline: 0;\n}\n\n\n// Sizing\n//\n// Remix the default button sizing classes into new ones for easier manipulation.\n\n.btn-group-xs > .btn { &:extend(.btn-xs); }\n.btn-group-sm > .btn { &:extend(.btn-sm); }\n.btn-group-lg > .btn { &:extend(.btn-lg); }\n\n\n// Split button dropdowns\n// ----------------------\n\n// Give the line between buttons some depth\n.btn-group > .btn + .dropdown-toggle {\n  padding-left: 8px;\n  padding-right: 8px;\n}\n.btn-group > .btn-lg + .dropdown-toggle {\n  padding-left: 12px;\n  padding-right: 12px;\n}\n\n// The clickable button for toggling the menu\n// Remove the gradient and set the same inset shadow as the :active state\n.btn-group.open .dropdown-toggle {\n  .box-shadow(inset 0 3px 5px rgba(0,0,0,.125));\n\n  // Show no shadow for `.btn-link` since it has no other button styles.\n  &.btn-link {\n    .box-shadow(none);\n  }\n}\n\n\n// Reposition the caret\n.btn .caret {\n  margin-left: 0;\n}\n// Carets in other button sizes\n.btn-lg .caret {\n  border-width: @caret-width-large @caret-width-large 0;\n  border-bottom-width: 0;\n}\n// Upside down carets for .dropup\n.dropup .btn-lg .caret {\n  border-width: 0 @caret-width-large @caret-width-large;\n}\n\n\n// Vertical button groups\n// ----------------------\n\n.btn-group-vertical {\n  > .btn,\n  > .btn-group,\n  > .btn-group > .btn {\n    display: block;\n    float: none;\n    width: 100%;\n    max-width: 100%;\n  }\n\n  // Clear floats so dropdown menus can be properly placed\n  > .btn-group {\n    &:extend(.clearfix all);\n    > .btn {\n      float: none;\n    }\n  }\n\n  > .btn + .btn,\n  > .btn + .btn-group,\n  > .btn-group + .btn,\n  > .btn-group + .btn-group {\n    margin-top: -1px;\n    margin-left: 0;\n  }\n}\n\n.btn-group-vertical > .btn {\n  &:not(:first-child):not(:last-child) {\n    border-radius: 0;\n  }\n  &:first-child:not(:last-child) {\n    border-top-right-radius: @border-radius-base;\n    .border-bottom-radius(0);\n  }\n  &:last-child:not(:first-child) {\n    border-bottom-left-radius: @border-radius-base;\n    .border-top-radius(0);\n  }\n}\n.btn-group-vertical > .btn-group:not(:first-child):not(:last-child) > .btn {\n  border-radius: 0;\n}\n.btn-group-vertical > .btn-group:first-child:not(:last-child) {\n  > .btn:last-child,\n  > .dropdown-toggle {\n    .border-bottom-radius(0);\n  }\n}\n.btn-group-vertical > .btn-group:last-child:not(:first-child) > .btn:first-child {\n  .border-top-radius(0);\n}\n\n\n\n// Justified button groups\n// ----------------------\n\n.btn-group-justified {\n  display: table;\n  width: 100%;\n  table-layout: fixed;\n  border-collapse: separate;\n  > .btn,\n  > .btn-group {\n    float: none;\n    display: table-cell;\n    width: 1%;\n  }\n  > .btn-group .btn {\n    width: 100%;\n  }\n}\n\n\n// Checkbox and radio options\n[data-toggle=\"buttons\"] > .btn > input[type=\"radio\"],\n[data-toggle=\"buttons\"] > .btn > input[type=\"checkbox\"] {\n  display: none;\n}\n","buttons.less":"//\n// Buttons\n// --------------------------------------------------\n\n\n// Base styles\n// --------------------------------------------------\n\n.btn {\n  display: inline-block;\n  margin-bottom: 0; // For input.btn\n  font-weight: @btn-font-weight;\n  text-align: center;\n  vertical-align: middle;\n  cursor: pointer;\n  background-image: none; // Reset unusual Firefox-on-Android default style; see https://github.com/necolas/normalize.css/issues/214\n  border: 1px solid transparent;\n  white-space: nowrap;\n  .button-size(@padding-base-vertical; @padding-base-horizontal; @font-size-base; @line-height-base; @border-radius-base);\n  .user-select(none);\n\n  &,\n  &:active,\n  &.active {\n    &:focus {\n      .tab-focus();\n    }\n  }\n\n  &:hover,\n  &:focus {\n    color: @btn-default-color;\n    text-decoration: none;\n  }\n\n  &:active,\n  &.active {\n    outline: 0;\n    background-image: none;\n    .box-shadow(inset 0 3px 5px rgba(0,0,0,.125));\n  }\n\n  &.disabled,\n  &[disabled],\n  fieldset[disabled] & {\n    cursor: not-allowed;\n    pointer-events: none; // Future-proof disabling of clicks\n    .opacity(.65);\n    .box-shadow(none);\n  }\n}\n\n\n// Alternate buttons\n// --------------------------------------------------\n\n.btn-default {\n  .button-variant(@btn-default-color; @btn-default-bg; @btn-default-border);\n}\n.btn-primary {\n  .button-variant(@btn-primary-color; @btn-primary-bg; @btn-primary-border);\n}\n// Success appears as green\n.btn-success {\n  .button-variant(@btn-success-color; @btn-success-bg; @btn-success-border);\n}\n// Info appears as blue-green\n.btn-info {\n  .button-variant(@btn-info-color; @btn-info-bg; @btn-info-border);\n}\n// Warning appears as orange\n.btn-warning {\n  .button-variant(@btn-warning-color; @btn-warning-bg; @btn-warning-border);\n}\n// Danger and error appear as red\n.btn-danger {\n  .button-variant(@btn-danger-color; @btn-danger-bg; @btn-danger-border);\n}\n\n\n// Link buttons\n// -------------------------\n\n// Make a button look and behave like a link\n.btn-link {\n  color: @link-color;\n  font-weight: normal;\n  cursor: pointer;\n  border-radius: 0;\n\n  &,\n  &:active,\n  &[disabled],\n  fieldset[disabled] & {\n    background-color: transparent;\n    .box-shadow(none);\n  }\n  &,\n  &:hover,\n  &:focus,\n  &:active {\n    border-color: transparent;\n  }\n  &:hover,\n  &:focus {\n    color: @link-hover-color;\n    text-decoration: underline;\n    background-color: transparent;\n  }\n  &[disabled],\n  fieldset[disabled] & {\n    &:hover,\n    &:focus {\n      color: @btn-link-disabled-color;\n      text-decoration: none;\n    }\n  }\n}\n\n\n// Button Sizes\n// --------------------------------------------------\n\n.btn-lg {\n  // line-height: ensure even-numbered height of button next to large input\n  .button-size(@padding-large-vertical; @padding-large-horizontal; @font-size-large; @line-height-large; @border-radius-large);\n}\n.btn-sm {\n  // line-height: ensure proper height of button next to small input\n  .button-size(@padding-small-vertical; @padding-small-horizontal; @font-size-small; @line-height-small; @border-radius-small);\n}\n.btn-xs {\n  .button-size(@padding-xs-vertical; @padding-xs-horizontal; @font-size-small; @line-height-small; @border-radius-small);\n}\n\n\n// Block button\n// --------------------------------------------------\n\n.btn-block {\n  display: block;\n  width: 100%;\n  padding-left: 0;\n  padding-right: 0;\n}\n\n// Vertically space out multiple block buttons\n.btn-block + .btn-block {\n  margin-top: 5px;\n}\n\n// Specificity overrides\ninput[type=\"submit\"],\ninput[type=\"reset\"],\ninput[type=\"button\"] {\n  &.btn-block {\n    width: 100%;\n  }\n}\n","carousel.less":"//\n// Carousel\n// --------------------------------------------------\n\n\n// Wrapper for the slide container and indicators\n.carousel {\n  position: relative;\n}\n\n.carousel-inner {\n  position: relative;\n  overflow: hidden;\n  width: 100%;\n\n  > .item {\n    display: none;\n    position: relative;\n    .transition(.6s ease-in-out left);\n\n    // Account for jankitude on images\n    > img,\n    > a > img {\n      &:extend(.img-responsive);\n      line-height: 1;\n    }\n  }\n\n  > .active,\n  > .next,\n  > .prev { display: block; }\n\n  > .active {\n    left: 0;\n  }\n\n  > .next,\n  > .prev {\n    position: absolute;\n    top: 0;\n    width: 100%;\n  }\n\n  > .next {\n    left: 100%;\n  }\n  > .prev {\n    left: -100%;\n  }\n  > .next.left,\n  > .prev.right {\n    left: 0;\n  }\n\n  > .active.left {\n    left: -100%;\n  }\n  > .active.right {\n    left: 100%;\n  }\n\n}\n\n// Left/right controls for nav\n// ---------------------------\n\n.carousel-control {\n  position: absolute;\n  top: 0;\n  left: 0;\n  bottom: 0;\n  width: @carousel-control-width;\n  .opacity(@carousel-control-opacity);\n  font-size: @carousel-control-font-size;\n  color: @carousel-control-color;\n  text-align: center;\n  text-shadow: @carousel-text-shadow;\n  // We can't have this transition here because WebKit cancels the carousel\n  // animation if you trip this while in the middle of another animation.\n\n  // Set gradients for backgrounds\n  &.left {\n    #gradient > .horizontal(@start-color: rgba(0,0,0,.5); @end-color: rgba(0,0,0,.0001));\n  }\n  &.right {\n    left: auto;\n    right: 0;\n    #gradient > .horizontal(@start-color: rgba(0,0,0,.0001); @end-color: rgba(0,0,0,.5));\n  }\n\n  // Hover/focus state\n  &:hover,\n  &:focus {\n    outline: none;\n    color: @carousel-control-color;\n    text-decoration: none;\n    .opacity(.9);\n  }\n\n  // Toggles\n  .icon-prev,\n  .icon-next,\n  .glyphicon-chevron-left,\n  .glyphicon-chevron-right {\n    position: absolute;\n    top: 50%;\n    z-index: 5;\n    display: inline-block;\n  }\n  .icon-prev,\n  .glyphicon-chevron-left {\n    left: 50%;\n  }\n  .icon-next,\n  .glyphicon-chevron-right {\n    right: 50%;\n  }\n  .icon-prev,\n  .icon-next {\n    width:  20px;\n    height: 20px;\n    margin-top: -10px;\n    margin-left: -10px;\n    font-family: serif;\n  }\n\n  .icon-prev {\n    &:before {\n      content: '\\2039';// SINGLE LEFT-POINTING ANGLE QUOTATION MARK (U+2039)\n    }\n  }\n  .icon-next {\n    &:before {\n      content: '\\203a';// SINGLE RIGHT-POINTING ANGLE QUOTATION MARK (U+203A)\n    }\n  }\n}\n\n// Optional indicator pips\n//\n// Add an unordered list with the following class and add a list item for each\n// slide your carousel holds.\n\n.carousel-indicators {\n  position: absolute;\n  bottom: 10px;\n  left: 50%;\n  z-index: 15;\n  width: 60%;\n  margin-left: -30%;\n  padding-left: 0;\n  list-style: none;\n  text-align: center;\n\n  li {\n    display: inline-block;\n    width:  10px;\n    height: 10px;\n    margin: 1px;\n    text-indent: -999px;\n    border: 1px solid @carousel-indicator-border-color;\n    border-radius: 10px;\n    cursor: pointer;\n\n    // IE8-9 hack for event handling\n    //\n    // Internet Explorer 8-9 does not support clicks on elements without a set\n    // `background-color`. We cannot use `filter` since that's not viewed as a\n    // background color by the browser. Thus, a hack is needed.\n    //\n    // For IE8, we set solid black as it doesn't support `rgba()`. For IE9, we\n    // set alpha transparency for the best results possible.\n    background-color: #000 \\9; // IE8\n    background-color: rgba(0,0,0,0); // IE9\n  }\n  .active {\n    margin: 0;\n    width:  12px;\n    height: 12px;\n    background-color: @carousel-indicator-active-bg;\n  }\n}\n\n// Optional captions\n// -----------------------------\n// Hidden by default for smaller viewports\n.carousel-caption {\n  position: absolute;\n  left: 15%;\n  right: 15%;\n  bottom: 20px;\n  z-index: 10;\n  padding-top: 20px;\n  padding-bottom: 20px;\n  color: @carousel-caption-color;\n  text-align: center;\n  text-shadow: @carousel-text-shadow;\n  & .btn {\n    text-shadow: none; // No shadow for button elements in carousel-caption\n  }\n}\n\n\n// Scale up controls for tablets and up\n@media screen and (min-width: @screen-sm-min) {\n\n  // Scale up the controls a smidge\n  .carousel-control {\n    .glyphicon-chevron-left,\n    .glyphicon-chevron-right,\n    .icon-prev,\n    .icon-next {\n      width: 30px;\n      height: 30px;\n      margin-top: -15px;\n      margin-left: -15px;\n      font-size: 30px;\n    }\n  }\n\n  // Show and left align the captions\n  .carousel-caption {\n    left: 20%;\n    right: 20%;\n    padding-bottom: 30px;\n  }\n\n  // Move up the indicators\n  .carousel-indicators {\n    bottom: 20px;\n  }\n}\n","close.less":"//\n// Close icons\n// --------------------------------------------------\n\n\n.close {\n  float: right;\n  font-size: (@font-size-base * 1.5);\n  font-weight: @close-font-weight;\n  line-height: 1;\n  color: @close-color;\n  text-shadow: @close-text-shadow;\n  .opacity(.2);\n\n  &:hover,\n  &:focus {\n    color: @close-color;\n    text-decoration: none;\n    cursor: pointer;\n    .opacity(.5);\n  }\n\n  // Additional properties for button version\n  // iOS requires the button element instead of an anchor tag.\n  // If you want the anchor version, it requires `href=\"#\"`.\n  button& {\n    padding: 0;\n    cursor: pointer;\n    background: transparent;\n    border: 0;\n    -webkit-appearance: none;\n  }\n}\n","code.less":"//\n// Code (inline and block)\n// --------------------------------------------------\n\n\n// Inline and block code styles\ncode,\nkbd,\npre,\nsamp {\n  font-family: @font-family-monospace;\n}\n\n// Inline code\ncode {\n  padding: 2px 4px;\n  font-size: 90%;\n  color: @code-color;\n  background-color: @code-bg;\n  white-space: nowrap;\n  border-radius: @border-radius-base;\n}\n\n// User input typically entered via keyboard\nkbd {\n  padding: 2px 4px;\n  font-size: 90%;\n  color: @kbd-color;\n  background-color: @kbd-bg;\n  border-radius: @border-radius-small;\n  box-shadow: inset 0 -1px 0 rgba(0,0,0,.25);\n}\n\n// Blocks of code\npre {\n  display: block;\n  padding: ((@line-height-computed - 1) / 2);\n  margin: 0 0 (@line-height-computed / 2);\n  font-size: (@font-size-base - 1); // 14px to 13px\n  line-height: @line-height-base;\n  word-break: break-all;\n  word-wrap: break-word;\n  color: @pre-color;\n  background-color: @pre-bg;\n  border: 1px solid @pre-border-color;\n  border-radius: @border-radius-base;\n\n  // Account for some code outputs that place code tags in pre tags\n  code {\n    padding: 0;\n    font-size: inherit;\n    color: inherit;\n    white-space: pre-wrap;\n    background-color: transparent;\n    border-radius: 0;\n  }\n}\n\n// Enable scrollable blocks of code\n.pre-scrollable {\n  max-height: @pre-scrollable-max-height;\n  overflow-y: scroll;\n}\n","component-animations.less":"//\n// Component animations\n// --------------------------------------------------\n\n// Heads up!\n//\n// We don't use the `.opacity()` mixin here since it causes a bug with text\n// fields in IE7-8. Source: https://github.com/twitter/bootstrap/pull/3552.\n\n.fade {\n  opacity: 0;\n  .transition(opacity .15s linear);\n  &.in {\n    opacity: 1;\n  }\n}\n\n.collapse {\n  display: none;\n  &.in {\n    display: block;\n  }\n}\n.collapsing {\n  position: relative;\n  height: 0;\n  overflow: hidden;\n  .transition(height .35s ease);\n}\n","dropdowns.less":"//\n// Dropdown menus\n// --------------------------------------------------\n\n\n// Dropdown arrow/caret\n.caret {\n  display: inline-block;\n  width: 0;\n  height: 0;\n  margin-left: 2px;\n  vertical-align: middle;\n  border-top:   @caret-width-base solid;\n  border-right: @caret-width-base solid transparent;\n  border-left:  @caret-width-base solid transparent;\n}\n\n// The dropdown wrapper (div)\n.dropdown {\n  position: relative;\n}\n\n// Prevent the focus on the dropdown toggle when closing dropdowns\n.dropdown-toggle:focus {\n  outline: 0;\n}\n\n// The dropdown menu (ul)\n.dropdown-menu {\n  position: absolute;\n  top: 100%;\n  left: 0;\n  z-index: @zindex-dropdown;\n  display: none; // none by default, but block on \"open\" of the menu\n  float: left;\n  min-width: 160px;\n  padding: 5px 0;\n  margin: 2px 0 0; // override default ul\n  list-style: none;\n  font-size: @font-size-base;\n  background-color: @dropdown-bg;\n  border: 1px solid @dropdown-fallback-border; // IE8 fallback\n  border: 1px solid @dropdown-border;\n  border-radius: @border-radius-base;\n  .box-shadow(0 6px 12px rgba(0,0,0,.175));\n  background-clip: padding-box;\n\n  // Aligns the dropdown menu to right\n  //\n  // Deprecated as of 3.1.0 in favor of `.dropdown-menu-[dir]`\n  &.pull-right {\n    right: 0;\n    left: auto;\n  }\n\n  // Dividers (basically an hr) within the dropdown\n  .divider {\n    .nav-divider(@dropdown-divider-bg);\n  }\n\n  // Links within the dropdown menu\n  > li > a {\n    display: block;\n    padding: 3px 20px;\n    clear: both;\n    font-weight: normal;\n    line-height: @line-height-base;\n    color: @dropdown-link-color;\n    white-space: nowrap; // prevent links from randomly breaking onto new lines\n  }\n}\n\n// Hover/Focus state\n.dropdown-menu > li > a {\n  &:hover,\n  &:focus {\n    text-decoration: none;\n    color: @dropdown-link-hover-color;\n    background-color: @dropdown-link-hover-bg;\n  }\n}\n\n// Active state\n.dropdown-menu > .active > a {\n  &,\n  &:hover,\n  &:focus {\n    color: @dropdown-link-active-color;\n    text-decoration: none;\n    outline: 0;\n    background-color: @dropdown-link-active-bg;\n  }\n}\n\n// Disabled state\n//\n// Gray out text and ensure the hover/focus state remains gray\n\n.dropdown-menu > .disabled > a {\n  &,\n  &:hover,\n  &:focus {\n    color: @dropdown-link-disabled-color;\n  }\n}\n// Nuke hover/focus effects\n.dropdown-menu > .disabled > a {\n  &:hover,\n  &:focus {\n    text-decoration: none;\n    background-color: transparent;\n    background-image: none; // Remove CSS gradient\n    .reset-filter();\n    cursor: not-allowed;\n  }\n}\n\n// Open state for the dropdown\n.open {\n  // Show the menu\n  > .dropdown-menu {\n    display: block;\n  }\n\n  // Remove the outline when :focus is triggered\n  > a {\n    outline: 0;\n  }\n}\n\n// Menu positioning\n//\n// Add extra class to `.dropdown-menu` to flip the alignment of the dropdown\n// menu with the parent.\n.dropdown-menu-right {\n  left: auto; // Reset the default from `.dropdown-menu`\n  right: 0;\n}\n// With v3, we enabled auto-flipping if you have a dropdown within a right\n// aligned nav component. To enable the undoing of that, we provide an override\n// to restore the default dropdown menu alignment.\n//\n// This is only for left-aligning a dropdown menu within a `.navbar-right` or\n// `.pull-right` nav component.\n.dropdown-menu-left {\n  left: 0;\n  right: auto;\n}\n\n// Dropdown section headers\n.dropdown-header {\n  display: block;\n  padding: 3px 20px;\n  font-size: @font-size-small;\n  line-height: @line-height-base;\n  color: @dropdown-header-color;\n}\n\n// Backdrop to catch body clicks on mobile, etc.\n.dropdown-backdrop {\n  position: fixed;\n  left: 0;\n  right: 0;\n  bottom: 0;\n  top: 0;\n  z-index: (@zindex-dropdown - 10);\n}\n\n// Right aligned dropdowns\n.pull-right > .dropdown-menu {\n  right: 0;\n  left: auto;\n}\n\n// Allow for dropdowns to go bottom up (aka, dropup-menu)\n//\n// Just add .dropup after the standard .dropdown class and you're set, bro.\n// TODO: abstract this so that the navbar fixed styles are not placed here?\n\n.dropup,\n.navbar-fixed-bottom .dropdown {\n  // Reverse the caret\n  .caret {\n    border-top: 0;\n    border-bottom: @caret-width-base solid;\n    content: \"\";\n  }\n  // Different positioning for bottom up menu\n  .dropdown-menu {\n    top: auto;\n    bottom: 100%;\n    margin-bottom: 1px;\n  }\n}\n\n\n// Component alignment\n//\n// Reiterate per navbar.less and the modified component alignment there.\n\n@media (min-width: @grid-float-breakpoint) {\n  .navbar-right {\n    .dropdown-menu {\n      .dropdown-menu-right();\n    }\n    // Necessary for overrides of the default right aligned menu.\n    // Will remove come v4 in all likelihood.\n    .dropdown-menu-left {\n      .dropdown-menu-left();\n    }\n  }\n}\n\n","forms.less":"//\n// Forms\n// --------------------------------------------------\n\n\n// Normalize non-controls\n//\n// Restyle and baseline non-control form elements.\n\nfieldset {\n  padding: 0;\n  margin: 0;\n  border: 0;\n  // Chrome and Firefox set a `min-width: -webkit-min-content;` on fieldsets,\n  // so we reset that to ensure it behaves more like a standard block element.\n  // See https://github.com/twbs/bootstrap/issues/12359.\n  min-width: 0;\n}\n\nlegend {\n  display: block;\n  width: 100%;\n  padding: 0;\n  margin-bottom: @line-height-computed;\n  font-size: (@font-size-base * 1.5);\n  line-height: inherit;\n  color: @legend-color;\n  border: 0;\n  border-bottom: 1px solid @legend-border-color;\n}\n\nlabel {\n  display: inline-block;\n  margin-bottom: 5px;\n  font-weight: bold;\n}\n\n\n// Normalize form controls\n//\n// While most of our form styles require extra classes, some basic normalization\n// is required to ensure optimum display with or without those classes to better\n// address browser inconsistencies.\n\n// Override content-box in Normalize (* isn't specific enough)\ninput[type=\"search\"] {\n  .box-sizing(border-box);\n}\n\n// Position radios and checkboxes better\ninput[type=\"radio\"],\ninput[type=\"checkbox\"] {\n  margin: 4px 0 0;\n  margin-top: 1px \\9; /* IE8-9 */\n  line-height: normal;\n}\n\n// Set the height of file controls to match text inputs\ninput[type=\"file\"] {\n  display: block;\n}\n\n// Make range inputs behave like textual form controls\ninput[type=\"range\"] {\n  display: block;\n  width: 100%;\n}\n\n// Make multiple select elements height not fixed\nselect[multiple],\nselect[size] {\n  height: auto;\n}\n\n// Focus for file, radio, and checkbox\ninput[type=\"file\"]:focus,\ninput[type=\"radio\"]:focus,\ninput[type=\"checkbox\"]:focus {\n  .tab-focus();\n}\n\n// Adjust output element\noutput {\n  display: block;\n  padding-top: (@padding-base-vertical + 1);\n  font-size: @font-size-base;\n  line-height: @line-height-base;\n  color: @input-color;\n}\n\n\n// Common form controls\n//\n// Shared size and type resets for form controls. Apply `.form-control` to any\n// of the following form controls:\n//\n// select\n// textarea\n// input[type=\"text\"]\n// input[type=\"password\"]\n// input[type=\"datetime\"]\n// input[type=\"datetime-local\"]\n// input[type=\"date\"]\n// input[type=\"month\"]\n// input[type=\"time\"]\n// input[type=\"week\"]\n// input[type=\"number\"]\n// input[type=\"email\"]\n// input[type=\"url\"]\n// input[type=\"search\"]\n// input[type=\"tel\"]\n// input[type=\"color\"]\n\n.form-control {\n  display: block;\n  width: 100%;\n  height: @input-height-base; // Make inputs at least the height of their button counterpart (base line-height + padding + border)\n  padding: @padding-base-vertical @padding-base-horizontal;\n  font-size: @font-size-base;\n  line-height: @line-height-base;\n  color: @input-color;\n  background-color: @input-bg;\n  background-image: none; // Reset unusual Firefox-on-Android default style; see https://github.com/necolas/normalize.css/issues/214\n  border: 1px solid @input-border;\n  border-radius: @input-border-radius;\n  .box-shadow(inset 0 1px 1px rgba(0,0,0,.075));\n  .transition(~\"border-color ease-in-out .15s, box-shadow ease-in-out .15s\");\n\n  // Customize the `:focus` state to imitate native WebKit styles.\n  .form-control-focus();\n\n  // Placeholder\n  .placeholder();\n\n  // Disabled and read-only inputs\n  //\n  // HTML5 says that controls under a fieldset > legend:first-child won't be\n  // disabled if the fieldset is disabled. Due to implementation difficulty, we\n  // don't honor that edge case; we style them as disabled anyway.\n  &[disabled],\n  &[readonly],\n  fieldset[disabled] & {\n    cursor: not-allowed;\n    background-color: @input-bg-disabled;\n    opacity: 1; // iOS fix for unreadable disabled content\n  }\n\n  // Reset height for `textarea`s\n  textarea& {\n    height: auto;\n  }\n}\n\n\n// Search inputs in iOS\n//\n// This overrides the extra rounded corners on search inputs in iOS so that our\n// `.form-control` class can properly style them. Note that this cannot simply\n// be added to `.form-control` as it's not specific enough. For details, see\n// https://github.com/twbs/bootstrap/issues/11586.\n\ninput[type=\"search\"] {\n  -webkit-appearance: none;\n}\n\n\n// Special styles for iOS date input\n//\n// In Mobile Safari, date inputs require a pixel line-height that matches the\n// given height of the input.\n\ninput[type=\"date\"] {\n  line-height: @input-height-base;\n}\n\n\n// Form groups\n//\n// Designed to help with the organization and spacing of vertical forms. For\n// horizontal forms, use the predefined grid classes.\n\n.form-group {\n  margin-bottom: 15px;\n}\n\n\n// Checkboxes and radios\n//\n// Indent the labels to position radios/checkboxes as hanging controls.\n\n.radio,\n.checkbox {\n  display: block;\n  min-height: @line-height-computed; // clear the floating input if there is no label text\n  margin-top: 10px;\n  margin-bottom: 10px;\n  padding-left: 20px;\n  label {\n    display: inline;\n    font-weight: normal;\n    cursor: pointer;\n  }\n}\n.radio input[type=\"radio\"],\n.radio-inline input[type=\"radio\"],\n.checkbox input[type=\"checkbox\"],\n.checkbox-inline input[type=\"checkbox\"] {\n  float: left;\n  margin-left: -20px;\n}\n.radio + .radio,\n.checkbox + .checkbox {\n  margin-top: -5px; // Move up sibling radios or checkboxes for tighter spacing\n}\n\n// Radios and checkboxes on same line\n.radio-inline,\n.checkbox-inline {\n  display: inline-block;\n  padding-left: 20px;\n  margin-bottom: 0;\n  vertical-align: middle;\n  font-weight: normal;\n  cursor: pointer;\n}\n.radio-inline + .radio-inline,\n.checkbox-inline + .checkbox-inline {\n  margin-top: 0;\n  margin-left: 10px; // space out consecutive inline controls\n}\n\n// Apply same disabled cursor tweak as for inputs\n//\n// Note: Neither radios nor checkboxes can be readonly.\ninput[type=\"radio\"],\ninput[type=\"checkbox\"],\n.radio,\n.radio-inline,\n.checkbox,\n.checkbox-inline {\n  &[disabled],\n  fieldset[disabled] & {\n    cursor: not-allowed;\n  }\n}\n\n\n// Form control sizing\n//\n// Build on `.form-control` with modifier classes to decrease or increase the\n// height and font-size of form controls.\n\n.input-sm {\n  .input-size(@input-height-small; @padding-small-vertical; @padding-small-horizontal; @font-size-small; @line-height-small; @border-radius-small);\n}\n\n.input-lg {\n  .input-size(@input-height-large; @padding-large-vertical; @padding-large-horizontal; @font-size-large; @line-height-large; @border-radius-large);\n}\n\n\n// Form control feedback states\n//\n// Apply contextual and semantic states to individual form controls.\n\n.has-feedback {\n  // Enable absolute positioning\n  position: relative;\n\n  // Ensure icons don't overlap text\n  .form-control {\n    padding-right: (@input-height-base * 1.25);\n  }\n\n  // Feedback icon (requires .glyphicon classes)\n  .form-control-feedback {\n    position: absolute;\n    top: (@line-height-computed + 5); // Height of the `label` and its margin\n    right: 0;\n    display: block;\n    width: @input-height-base;\n    height: @input-height-base;\n    line-height: @input-height-base;\n    text-align: center;\n  }\n}\n\n// Feedback states\n.has-success {\n  .form-control-validation(@state-success-text; @state-success-text; @state-success-bg);\n}\n.has-warning {\n  .form-control-validation(@state-warning-text; @state-warning-text; @state-warning-bg);\n}\n.has-error {\n  .form-control-validation(@state-danger-text; @state-danger-text; @state-danger-bg);\n}\n\n\n// Static form control text\n//\n// Apply class to a `p` element to make any string of text align with labels in\n// a horizontal form layout.\n\n.form-control-static {\n  margin-bottom: 0; // Remove default margin from `p`\n}\n\n\n// Help text\n//\n// Apply to any element you wish to create light text for placement immediately\n// below a form control. Use for general help, formatting, or instructional text.\n\n.help-block {\n  display: block; // account for any element using help-block\n  margin-top: 5px;\n  margin-bottom: 10px;\n  color: lighten(@text-color, 25%); // lighten the text some for contrast\n}\n\n\n\n// Inline forms\n//\n// Make forms appear inline(-block) by adding the `.form-inline` class. Inline\n// forms begin stacked on extra small (mobile) devices and then go inline when\n// viewports reach <768px.\n//\n// Requires wrapping inputs and labels with `.form-group` for proper display of\n// default HTML form controls and our custom form controls (e.g., input groups).\n//\n// Heads up! This is mixin-ed into `.navbar-form` in navbars.less.\n\n.form-inline {\n\n  // Kick in the inline\n  @media (min-width: @screen-sm-min) {\n    // Inline-block all the things for \"inline\"\n    .form-group {\n      display: inline-block;\n      margin-bottom: 0;\n      vertical-align: middle;\n    }\n\n    // In navbar-form, allow folks to *not* use `.form-group`\n    .form-control {\n      display: inline-block;\n      width: auto; // Prevent labels from stacking above inputs in `.form-group`\n      vertical-align: middle;\n    }\n    // Input groups need that 100% width though\n    .input-group > .form-control {\n      width: 100%;\n    }\n\n    .control-label {\n      margin-bottom: 0;\n      vertical-align: middle;\n    }\n\n    // Remove default margin on radios/checkboxes that were used for stacking, and\n    // then undo the floating of radios and checkboxes to match (which also avoids\n    // a bug in WebKit: https://github.com/twbs/bootstrap/issues/1969).\n    .radio,\n    .checkbox {\n      display: inline-block;\n      margin-top: 0;\n      margin-bottom: 0;\n      padding-left: 0;\n      vertical-align: middle;\n    }\n    .radio input[type=\"radio\"],\n    .checkbox input[type=\"checkbox\"] {\n      float: none;\n      margin-left: 0;\n    }\n\n    // Validation states\n    //\n    // Reposition the icon because it's now within a grid column and columns have\n    // `position: relative;` on them. Also accounts for the grid gutter padding.\n    .has-feedback .form-control-feedback {\n      top: 0;\n    }\n  }\n}\n\n\n// Horizontal forms\n//\n// Horizontal forms are built on grid classes and allow you to create forms with\n// labels on the left and inputs on the right.\n\n.form-horizontal {\n\n  // Consistent vertical alignment of labels, radios, and checkboxes\n  .control-label,\n  .radio,\n  .checkbox,\n  .radio-inline,\n  .checkbox-inline {\n    margin-top: 0;\n    margin-bottom: 0;\n    padding-top: (@padding-base-vertical + 1); // Default padding plus a border\n  }\n  // Account for padding we're adding to ensure the alignment and of help text\n  // and other content below items\n  .radio,\n  .checkbox {\n    min-height: (@line-height-computed + (@padding-base-vertical + 1));\n  }\n\n  // Make form groups behave like rows\n  .form-group {\n    .make-row();\n  }\n\n  .form-control-static {\n    padding-top: (@padding-base-vertical + 1);\n  }\n\n  // Only right align form labels here when the columns stop stacking\n  @media (min-width: @screen-sm-min) {\n    .control-label {\n      text-align: right;\n    }\n  }\n\n  // Validation states\n  //\n  // Reposition the icon because it's now within a grid column and columns have\n  // `position: relative;` on them. Also accounts for the grid gutter padding.\n  .has-feedback .form-control-feedback {\n    top: 0;\n    right: (@grid-gutter-width / 2);\n  }\n}\n","glyphicons.less":"//\n// Glyphicons for Bootstrap\n//\n// Since icons are fonts, they can be placed anywhere text is placed and are\n// thus automatically sized to match the surrounding child. To use, create an\n// inline element with the appropriate classes, like so:\n//\n// <a href=\"#\"><span class=\"glyphicon glyphicon-star\"></span> Star</a>\n\n// Import the fonts\n@font-face {\n  font-family: 'Glyphicons Halflings';\n  src: ~\"url('@{icon-font-path}@{icon-font-name}.eot')\";\n  src: ~\"url('@{icon-font-path}@{icon-font-name}.eot?#iefix') format('embedded-opentype')\",\n       ~\"url('@{icon-font-path}@{icon-font-name}.woff') format('woff')\",\n       ~\"url('@{icon-font-path}@{icon-font-name}.ttf') format('truetype')\",\n       ~\"url('@{icon-font-path}@{icon-font-name}.svg#@{icon-font-svg-id}') format('svg')\";\n}\n\n// Catchall baseclass\n.glyphicon {\n  position: relative;\n  top: 1px;\n  display: inline-block;\n  font-family: 'Glyphicons Halflings';\n  font-style: normal;\n  font-weight: normal;\n  line-height: 1;\n  -webkit-font-smoothing: antialiased;\n  -moz-osx-font-smoothing: grayscale;\n}\n\n// Individual icons\n.glyphicon-asterisk               { &:before { content: \"\\2a\"; } }\n.glyphicon-plus                   { &:before { content: \"\\2b\"; } }\n.glyphicon-euro                   { &:before { content: \"\\20ac\"; } }\n.glyphicon-minus                  { &:before { content: \"\\2212\"; } }\n.glyphicon-cloud                  { &:before { content: \"\\2601\"; } }\n.glyphicon-envelope               { &:before { content: \"\\2709\"; } }\n.glyphicon-pencil                 { &:before { content: \"\\270f\"; } }\n.glyphicon-glass                  { &:before { content: \"\\e001\"; } }\n.glyphicon-music                  { &:before { content: \"\\e002\"; } }\n.glyphicon-search                 { &:before { content: \"\\e003\"; } }\n.glyphicon-heart                  { &:before { content: \"\\e005\"; } }\n.glyphicon-star                   { &:before { content: \"\\e006\"; } }\n.glyphicon-star-empty             { &:before { content: \"\\e007\"; } }\n.glyphicon-user                   { &:before { content: \"\\e008\"; } }\n.glyphicon-film                   { &:before { content: \"\\e009\"; } }\n.glyphicon-th-large               { &:before { content: \"\\e010\"; } }\n.glyphicon-th                     { &:before { content: \"\\e011\"; } }\n.glyphicon-th-list                { &:before { content: \"\\e012\"; } }\n.glyphicon-ok                     { &:before { content: \"\\e013\"; } }\n.glyphicon-remove                 { &:before { content: \"\\e014\"; } }\n.glyphicon-zoom-in                { &:before { content: \"\\e015\"; } }\n.glyphicon-zoom-out               { &:before { content: \"\\e016\"; } }\n.glyphicon-off                    { &:before { content: \"\\e017\"; } }\n.glyphicon-signal                 { &:before { content: \"\\e018\"; } }\n.glyphicon-cog                    { &:before { content: \"\\e019\"; } }\n.glyphicon-trash                  { &:before { content: \"\\e020\"; } }\n.glyphicon-home                   { &:before { content: \"\\e021\"; } }\n.glyphicon-file                   { &:before { content: \"\\e022\"; } }\n.glyphicon-time                   { &:before { content: \"\\e023\"; } }\n.glyphicon-road                   { &:before { content: \"\\e024\"; } }\n.glyphicon-download-alt           { &:before { content: \"\\e025\"; } }\n.glyphicon-download               { &:before { content: \"\\e026\"; } }\n.glyphicon-upload                 { &:before { content: \"\\e027\"; } }\n.glyphicon-inbox                  { &:before { content: \"\\e028\"; } }\n.glyphicon-play-circle            { &:before { content: \"\\e029\"; } }\n.glyphicon-repeat                 { &:before { content: \"\\e030\"; } }\n.glyphicon-refresh                { &:before { content: \"\\e031\"; } }\n.glyphicon-list-alt               { &:before { content: \"\\e032\"; } }\n.glyphicon-lock                   { &:before { content: \"\\e033\"; } }\n.glyphicon-flag                   { &:before { content: \"\\e034\"; } }\n.glyphicon-headphones             { &:before { content: \"\\e035\"; } }\n.glyphicon-volume-off             { &:before { content: \"\\e036\"; } }\n.glyphicon-volume-down            { &:before { content: \"\\e037\"; } }\n.glyphicon-volume-up              { &:before { content: \"\\e038\"; } }\n.glyphicon-qrcode                 { &:before { content: \"\\e039\"; } }\n.glyphicon-barcode                { &:before { content: \"\\e040\"; } }\n.glyphicon-tag                    { &:before { content: \"\\e041\"; } }\n.glyphicon-tags                   { &:before { content: \"\\e042\"; } }\n.glyphicon-book                   { &:before { content: \"\\e043\"; } }\n.glyphicon-bookmark               { &:before { content: \"\\e044\"; } }\n.glyphicon-print                  { &:before { content: \"\\e045\"; } }\n.glyphicon-camera                 { &:before { content: \"\\e046\"; } }\n.glyphicon-font                   { &:before { content: \"\\e047\"; } }\n.glyphicon-bold                   { &:before { content: \"\\e048\"; } }\n.glyphicon-italic                 { &:before { content: \"\\e049\"; } }\n.glyphicon-text-height            { &:before { content: \"\\e050\"; } }\n.glyphicon-text-width             { &:before { content: \"\\e051\"; } }\n.glyphicon-align-left             { &:before { content: \"\\e052\"; } }\n.glyphicon-align-center           { &:before { content: \"\\e053\"; } }\n.glyphicon-align-right            { &:before { content: \"\\e054\"; } }\n.glyphicon-align-justify          { &:before { content: \"\\e055\"; } }\n.glyphicon-list                   { &:before { content: \"\\e056\"; } }\n.glyphicon-indent-left            { &:before { content: \"\\e057\"; } }\n.glyphicon-indent-right           { &:before { content: \"\\e058\"; } }\n.glyphicon-facetime-video         { &:before { content: \"\\e059\"; } }\n.glyphicon-picture                { &:before { content: \"\\e060\"; } }\n.glyphicon-map-marker             { &:before { content: \"\\e062\"; } }\n.glyphicon-adjust                 { &:before { content: \"\\e063\"; } }\n.glyphicon-tint                   { &:before { content: \"\\e064\"; } }\n.glyphicon-edit                   { &:before { content: \"\\e065\"; } }\n.glyphicon-share                  { &:before { content: \"\\e066\"; } }\n.glyphicon-check                  { &:before { content: \"\\e067\"; } }\n.glyphicon-move                   { &:before { content: \"\\e068\"; } }\n.glyphicon-step-backward          { &:before { content: \"\\e069\"; } }\n.glyphicon-fast-backward          { &:before { content: \"\\e070\"; } }\n.glyphicon-backward               { &:before { content: \"\\e071\"; } }\n.glyphicon-play                   { &:before { content: \"\\e072\"; } }\n.glyphicon-pause                  { &:before { content: \"\\e073\"; } }\n.glyphicon-stop                   { &:before { content: \"\\e074\"; } }\n.glyphicon-forward                { &:before { content: \"\\e075\"; } }\n.glyphicon-fast-forward           { &:before { content: \"\\e076\"; } }\n.glyphicon-step-forward           { &:before { content: \"\\e077\"; } }\n.glyphicon-eject                  { &:before { content: \"\\e078\"; } }\n.glyphicon-chevron-left           { &:before { content: \"\\e079\"; } }\n.glyphicon-chevron-right          { &:before { content: \"\\e080\"; } }\n.glyphicon-plus-sign              { &:before { content: \"\\e081\"; } }\n.glyphicon-minus-sign             { &:before { content: \"\\e082\"; } }\n.glyphicon-remove-sign            { &:before { content: \"\\e083\"; } }\n.glyphicon-ok-sign                { &:before { content: \"\\e084\"; } }\n.glyphicon-question-sign          { &:before { content: \"\\e085\"; } }\n.glyphicon-info-sign              { &:before { content: \"\\e086\"; } }\n.glyphicon-screenshot             { &:before { content: \"\\e087\"; } }\n.glyphicon-remove-circle          { &:before { content: \"\\e088\"; } }\n.glyphicon-ok-circle              { &:before { content: \"\\e089\"; } }\n.glyphicon-ban-circle             { &:before { content: \"\\e090\"; } }\n.glyphicon-arrow-left             { &:before { content: \"\\e091\"; } }\n.glyphicon-arrow-right            { &:before { content: \"\\e092\"; } }\n.glyphicon-arrow-up               { &:before { content: \"\\e093\"; } }\n.glyphicon-arrow-down             { &:before { content: \"\\e094\"; } }\n.glyphicon-share-alt              { &:before { content: \"\\e095\"; } }\n.glyphicon-resize-full            { &:before { content: \"\\e096\"; } }\n.glyphicon-resize-small           { &:before { content: \"\\e097\"; } }\n.glyphicon-exclamation-sign       { &:before { content: \"\\e101\"; } }\n.glyphicon-gift                   { &:before { content: \"\\e102\"; } }\n.glyphicon-leaf                   { &:before { content: \"\\e103\"; } }\n.glyphicon-fire                   { &:before { content: \"\\e104\"; } }\n.glyphicon-eye-open               { &:before { content: \"\\e105\"; } }\n.glyphicon-eye-close              { &:before { content: \"\\e106\"; } }\n.glyphicon-warning-sign           { &:before { content: \"\\e107\"; } }\n.glyphicon-plane                  { &:before { content: \"\\e108\"; } }\n.glyphicon-calendar               { &:before { content: \"\\e109\"; } }\n.glyphicon-random                 { &:before { content: \"\\e110\"; } }\n.glyphicon-comment                { &:before { content: \"\\e111\"; } }\n.glyphicon-magnet                 { &:before { content: \"\\e112\"; } }\n.glyphicon-chevron-up             { &:before { content: \"\\e113\"; } }\n.glyphicon-chevron-down           { &:before { content: \"\\e114\"; } }\n.glyphicon-retweet                { &:before { content: \"\\e115\"; } }\n.glyphicon-shopping-cart          { &:before { content: \"\\e116\"; } }\n.glyphicon-folder-close           { &:before { content: \"\\e117\"; } }\n.glyphicon-folder-open            { &:before { content: \"\\e118\"; } }\n.glyphicon-resize-vertical        { &:before { content: \"\\e119\"; } }\n.glyphicon-resize-horizontal      { &:before { content: \"\\e120\"; } }\n.glyphicon-hdd                    { &:before { content: \"\\e121\"; } }\n.glyphicon-bullhorn               { &:before { content: \"\\e122\"; } }\n.glyphicon-bell                   { &:before { content: \"\\e123\"; } }\n.glyphicon-certificate            { &:before { content: \"\\e124\"; } }\n.glyphicon-thumbs-up              { &:before { content: \"\\e125\"; } }\n.glyphicon-thumbs-down            { &:before { content: \"\\e126\"; } }\n.glyphicon-hand-right             { &:before { content: \"\\e127\"; } }\n.glyphicon-hand-left              { &:before { content: \"\\e128\"; } }\n.glyphicon-hand-up                { &:before { content: \"\\e129\"; } }\n.glyphicon-hand-down              { &:before { content: \"\\e130\"; } }\n.glyphicon-circle-arrow-right     { &:before { content: \"\\e131\"; } }\n.glyphicon-circle-arrow-left      { &:before { content: \"\\e132\"; } }\n.glyphicon-circle-arrow-up        { &:before { content: \"\\e133\"; } }\n.glyphicon-circle-arrow-down      { &:before { content: \"\\e134\"; } }\n.glyphicon-globe                  { &:before { content: \"\\e135\"; } }\n.glyphicon-wrench                 { &:before { content: \"\\e136\"; } }\n.glyphicon-tasks                  { &:before { content: \"\\e137\"; } }\n.glyphicon-filter                 { &:before { content: \"\\e138\"; } }\n.glyphicon-briefcase              { &:before { content: \"\\e139\"; } }\n.glyphicon-fullscreen             { &:before { content: \"\\e140\"; } }\n.glyphicon-dashboard              { &:before { content: \"\\e141\"; } }\n.glyphicon-paperclip              { &:before { content: \"\\e142\"; } }\n.glyphicon-heart-empty            { &:before { content: \"\\e143\"; } }\n.glyphicon-link                   { &:before { content: \"\\e144\"; } }\n.glyphicon-phone                  { &:before { content: \"\\e145\"; } }\n.glyphicon-pushpin                { &:before { content: \"\\e146\"; } }\n.glyphicon-usd                    { &:before { content: \"\\e148\"; } }\n.glyphicon-gbp                    { &:before { content: \"\\e149\"; } }\n.glyphicon-sort                   { &:before { content: \"\\e150\"; } }\n.glyphicon-sort-by-alphabet       { &:before { content: \"\\e151\"; } }\n.glyphicon-sort-by-alphabet-alt   { &:before { content: \"\\e152\"; } }\n.glyphicon-sort-by-order          { &:before { content: \"\\e153\"; } }\n.glyphicon-sort-by-order-alt      { &:before { content: \"\\e154\"; } }\n.glyphicon-sort-by-attributes     { &:before { content: \"\\e155\"; } }\n.glyphicon-sort-by-attributes-alt { &:before { content: \"\\e156\"; } }\n.glyphicon-unchecked              { &:before { content: \"\\e157\"; } }\n.glyphicon-expand                 { &:before { content: \"\\e158\"; } }\n.glyphicon-collapse-down          { &:before { content: \"\\e159\"; } }\n.glyphicon-collapse-up            { &:before { content: \"\\e160\"; } }\n.glyphicon-log-in                 { &:before { content: \"\\e161\"; } }\n.glyphicon-flash                  { &:before { content: \"\\e162\"; } }\n.glyphicon-log-out                { &:before { content: \"\\e163\"; } }\n.glyphicon-new-window             { &:before { content: \"\\e164\"; } }\n.glyphicon-record                 { &:before { content: \"\\e165\"; } }\n.glyphicon-save                   { &:before { content: \"\\e166\"; } }\n.glyphicon-open                   { &:before { content: \"\\e167\"; } }\n.glyphicon-saved                  { &:before { content: \"\\e168\"; } }\n.glyphicon-import                 { &:before { content: \"\\e169\"; } }\n.glyphicon-export                 { &:before { content: \"\\e170\"; } }\n.glyphicon-send                   { &:before { content: \"\\e171\"; } }\n.glyphicon-floppy-disk            { &:before { content: \"\\e172\"; } }\n.glyphicon-floppy-saved           { &:before { content: \"\\e173\"; } }\n.glyphicon-floppy-remove          { &:before { content: \"\\e174\"; } }\n.glyphicon-floppy-save            { &:before { content: \"\\e175\"; } }\n.glyphicon-floppy-open            { &:before { content: \"\\e176\"; } }\n.glyphicon-credit-card            { &:before { content: \"\\e177\"; } }\n.glyphicon-transfer               { &:before { content: \"\\e178\"; } }\n.glyphicon-cutlery                { &:before { content: \"\\e179\"; } }\n.glyphicon-header                 { &:before { content: \"\\e180\"; } }\n.glyphicon-compressed             { &:before { content: \"\\e181\"; } }\n.glyphicon-earphone               { &:before { content: \"\\e182\"; } }\n.glyphicon-phone-alt              { &:before { content: \"\\e183\"; } }\n.glyphicon-tower                  { &:before { content: \"\\e184\"; } }\n.glyphicon-stats                  { &:before { content: \"\\e185\"; } }\n.glyphicon-sd-video               { &:before { content: \"\\e186\"; } }\n.glyphicon-hd-video               { &:before { content: \"\\e187\"; } }\n.glyphicon-subtitles              { &:before { content: \"\\e188\"; } }\n.glyphicon-sound-stereo           { &:before { content: \"\\e189\"; } }\n.glyphicon-sound-dolby            { &:before { content: \"\\e190\"; } }\n.glyphicon-sound-5-1              { &:before { content: \"\\e191\"; } }\n.glyphicon-sound-6-1              { &:before { content: \"\\e192\"; } }\n.glyphicon-sound-7-1              { &:before { content: \"\\e193\"; } }\n.glyphicon-copyright-mark         { &:before { content: \"\\e194\"; } }\n.glyphicon-registration-mark      { &:before { content: \"\\e195\"; } }\n.glyphicon-cloud-download         { &:before { content: \"\\e197\"; } }\n.glyphicon-cloud-upload           { &:before { content: \"\\e198\"; } }\n.glyphicon-tree-conifer           { &:before { content: \"\\e199\"; } }\n.glyphicon-tree-deciduous         { &:before { content: \"\\e200\"; } }\n","grid.less":"//\n// Grid system\n// --------------------------------------------------\n\n\n// Container widths\n//\n// Set the container width, and override it for fixed navbars in media queries.\n\n.container {\n  .container-fixed();\n\n  @media (min-width: @screen-sm-min) {\n    width: @container-sm;\n  }\n  @media (min-width: @screen-md-min) {\n    width: @container-md;\n  }\n  @media (min-width: @screen-lg-min) {\n    width: @container-lg;\n  }\n}\n\n\n// Fluid container\n//\n// Utilizes the mixin meant for fixed width containers, but without any defined\n// width for fluid, full width layouts.\n\n.container-fluid {\n  .container-fixed();\n}\n\n\n// Row\n//\n// Rows contain and clear the floats of your columns.\n\n.row {\n  .make-row();\n}\n\n\n// Columns\n//\n// Common styles for small and large grid columns\n\n.make-grid-columns();\n\n\n// Extra small grid\n//\n// Columns, offsets, pushes, and pulls for extra small devices like\n// smartphones.\n\n.make-grid(xs);\n\n\n// Small grid\n//\n// Columns, offsets, pushes, and pulls for the small device range, from phones\n// to tablets.\n\n@media (min-width: @screen-sm-min) {\n  .make-grid(sm);\n}\n\n\n// Medium grid\n//\n// Columns, offsets, pushes, and pulls for the desktop device range.\n\n@media (min-width: @screen-md-min) {\n  .make-grid(md);\n}\n\n\n// Large grid\n//\n// Columns, offsets, pushes, and pulls for the large desktop device range.\n\n@media (min-width: @screen-lg-min) {\n  .make-grid(lg);\n}\n","input-groups.less":"//\n// Input groups\n// --------------------------------------------------\n\n// Base styles\n// -------------------------\n.input-group {\n  position: relative; // For dropdowns\n  display: table;\n  border-collapse: separate; // prevent input groups from inheriting border styles from table cells when placed within a table\n\n  // Undo padding and float of grid classes\n  &[class*=\"col-\"] {\n    float: none;\n    padding-left: 0;\n    padding-right: 0;\n  }\n\n  .form-control {\n    // Ensure that the input is always above the *appended* addon button for\n    // proper border colors.\n    position: relative;\n    z-index: 2;\n\n    // IE9 fubars the placeholder attribute in text inputs and the arrows on\n    // select elements in input groups. To fix it, we float the input. Details:\n    // https://github.com/twbs/bootstrap/issues/11561#issuecomment-28936855\n    float: left;\n\n    width: 100%;\n    margin-bottom: 0;\n  }\n}\n\n// Sizing options\n//\n// Remix the default form control sizing classes into new ones for easier\n// manipulation.\n\n.input-group-lg > .form-control,\n.input-group-lg > .input-group-addon,\n.input-group-lg > .input-group-btn > .btn { .input-lg(); }\n.input-group-sm > .form-control,\n.input-group-sm > .input-group-addon,\n.input-group-sm > .input-group-btn > .btn { .input-sm(); }\n\n\n// Display as table-cell\n// -------------------------\n.input-group-addon,\n.input-group-btn,\n.input-group .form-control {\n  display: table-cell;\n\n  &:not(:first-child):not(:last-child) {\n    border-radius: 0;\n  }\n}\n// Addon and addon wrapper for buttons\n.input-group-addon,\n.input-group-btn {\n  width: 1%;\n  white-space: nowrap;\n  vertical-align: middle; // Match the inputs\n}\n\n// Text input groups\n// -------------------------\n.input-group-addon {\n  padding: @padding-base-vertical @padding-base-horizontal;\n  font-size: @font-size-base;\n  font-weight: normal;\n  line-height: 1;\n  color: @input-color;\n  text-align: center;\n  background-color: @input-group-addon-bg;\n  border: 1px solid @input-group-addon-border-color;\n  border-radius: @border-radius-base;\n\n  // Sizing\n  &.input-sm {\n    padding: @padding-small-vertical @padding-small-horizontal;\n    font-size: @font-size-small;\n    border-radius: @border-radius-small;\n  }\n  &.input-lg {\n    padding: @padding-large-vertical @padding-large-horizontal;\n    font-size: @font-size-large;\n    border-radius: @border-radius-large;\n  }\n\n  // Nuke default margins from checkboxes and radios to vertically center within.\n  input[type=\"radio\"],\n  input[type=\"checkbox\"] {\n    margin-top: 0;\n  }\n}\n\n// Reset rounded corners\n.input-group .form-control:first-child,\n.input-group-addon:first-child,\n.input-group-btn:first-child > .btn,\n.input-group-btn:first-child > .btn-group > .btn,\n.input-group-btn:first-child > .dropdown-toggle,\n.input-group-btn:last-child > .btn:not(:last-child):not(.dropdown-toggle),\n.input-group-btn:last-child > .btn-group:not(:last-child) > .btn {\n  .border-right-radius(0);\n}\n.input-group-addon:first-child {\n  border-right: 0;\n}\n.input-group .form-control:last-child,\n.input-group-addon:last-child,\n.input-group-btn:last-child > .btn,\n.input-group-btn:last-child > .btn-group > .btn,\n.input-group-btn:last-child > .dropdown-toggle,\n.input-group-btn:first-child > .btn:not(:first-child),\n.input-group-btn:first-child > .btn-group:not(:first-child) > .btn {\n  .border-left-radius(0);\n}\n.input-group-addon:last-child {\n  border-left: 0;\n}\n\n// Button input groups\n// -------------------------\n.input-group-btn {\n  position: relative;\n  // Jankily prevent input button groups from wrapping with `white-space` and\n  // `font-size` in combination with `inline-block` on buttons.\n  font-size: 0;\n  white-space: nowrap;\n\n  // Negative margin for spacing, position for bringing hovered/focused/actived\n  // element above the siblings.\n  > .btn {\n    position: relative;\n    + .btn {\n      margin-left: -1px;\n    }\n    // Bring the \"active\" button to the front\n    &:hover,\n    &:focus,\n    &:active {\n      z-index: 2;\n    }\n  }\n\n  // Negative margin to only have a 1px border between the two\n  &:first-child {\n    > .btn,\n    > .btn-group {\n      margin-right: -1px;\n    }\n  }\n  &:last-child {\n    > .btn,\n    > .btn-group {\n      margin-left: -1px;\n    }\n  }\n}\n","jumbotron.less":"//\n// Jumbotron\n// --------------------------------------------------\n\n\n.jumbotron {\n  padding: @jumbotron-padding;\n  margin-bottom: @jumbotron-padding;\n  color: @jumbotron-color;\n  background-color: @jumbotron-bg;\n\n  h1,\n  .h1 {\n    color: @jumbotron-heading-color;\n  }\n  p {\n    margin-bottom: (@jumbotron-padding / 2);\n    font-size: @jumbotron-font-size;\n    font-weight: 200;\n  }\n\n  .container & {\n    border-radius: @border-radius-large; // Only round corners at higher resolutions if contained in a container\n  }\n\n  .container {\n    max-width: 100%;\n  }\n\n  @media screen and (min-width: @screen-sm-min) {\n    padding-top:    (@jumbotron-padding * 1.6);\n    padding-bottom: (@jumbotron-padding * 1.6);\n\n    .container & {\n      padding-left:  (@jumbotron-padding * 2);\n      padding-right: (@jumbotron-padding * 2);\n    }\n\n    h1,\n    .h1 {\n      font-size: (@font-size-base * 4.5);\n    }\n  }\n}\n","labels.less":"//\n// Labels\n// --------------------------------------------------\n\n.label {\n  display: inline;\n  padding: .2em .6em .3em;\n  font-size: 75%;\n  font-weight: bold;\n  line-height: 1;\n  color: @label-color;\n  text-align: center;\n  white-space: nowrap;\n  vertical-align: baseline;\n  border-radius: .25em;\n\n  // Add hover effects, but only for links\n  &[href] {\n    &:hover,\n    &:focus {\n      color: @label-link-hover-color;\n      text-decoration: none;\n      cursor: pointer;\n    }\n  }\n\n  // Empty labels collapse automatically (not available in IE8)\n  &:empty {\n    display: none;\n  }\n\n  // Quick fix for labels in buttons\n  .btn & {\n    position: relative;\n    top: -1px;\n  }\n}\n\n// Colors\n// Contextual variations (linked labels get darker on :hover)\n\n.label-default {\n  .label-variant(@label-default-bg);\n}\n\n.label-primary {\n  .label-variant(@label-primary-bg);\n}\n\n.label-success {\n  .label-variant(@label-success-bg);\n}\n\n.label-info {\n  .label-variant(@label-info-bg);\n}\n\n.label-warning {\n  .label-variant(@label-warning-bg);\n}\n\n.label-danger {\n  .label-variant(@label-danger-bg);\n}\n","list-group.less":"//\n// List groups\n// --------------------------------------------------\n\n\n// Base class\n//\n// Easily usable on <ul>, <ol>, or <div>.\n\n.list-group {\n  // No need to set list-style: none; since .list-group-item is block level\n  margin-bottom: 20px;\n  padding-left: 0; // reset padding because ul and ol\n}\n\n\n// Individual list items\n//\n// Use on `li`s or `div`s within the `.list-group` parent.\n\n.list-group-item {\n  position: relative;\n  display: block;\n  padding: 10px 15px;\n  // Place the border on the list items and negative margin up for better styling\n  margin-bottom: -1px;\n  background-color: @list-group-bg;\n  border: 1px solid @list-group-border;\n\n  // Round the first and last items\n  &:first-child {\n    .border-top-radius(@list-group-border-radius);\n  }\n  &:last-child {\n    margin-bottom: 0;\n    .border-bottom-radius(@list-group-border-radius);\n  }\n\n  // Align badges within list items\n  > .badge {\n    float: right;\n  }\n  > .badge + .badge {\n    margin-right: 5px;\n  }\n}\n\n\n// Linked list items\n//\n// Use anchor elements instead of `li`s or `div`s to create linked list items.\n// Includes an extra `.active` modifier class for showing selected items.\n\na.list-group-item {\n  color: @list-group-link-color;\n\n  .list-group-item-heading {\n    color: @list-group-link-heading-color;\n  }\n\n  // Hover state\n  &:hover,\n  &:focus {\n    text-decoration: none;\n    background-color: @list-group-hover-bg;\n  }\n\n  // Active class on item itself, not parent\n  &.active,\n  &.active:hover,\n  &.active:focus {\n    z-index: 2; // Place active items above their siblings for proper border styling\n    color: @list-group-active-color;\n    background-color: @list-group-active-bg;\n    border-color: @list-group-active-border;\n\n    // Force color to inherit for custom content\n    .list-group-item-heading {\n      color: inherit;\n    }\n    .list-group-item-text {\n      color: @list-group-active-text-color;\n    }\n  }\n}\n\n\n// Contextual variants\n//\n// Add modifier classes to change text and background color on individual items.\n// Organizationally, this must come after the `:hover` states.\n\n.list-group-item-variant(success; @state-success-bg; @state-success-text);\n.list-group-item-variant(info; @state-info-bg; @state-info-text);\n.list-group-item-variant(warning; @state-warning-bg; @state-warning-text);\n.list-group-item-variant(danger; @state-danger-bg; @state-danger-text);\n\n\n// Custom content options\n//\n// Extra classes for creating well-formatted content within `.list-group-item`s.\n\n.list-group-item-heading {\n  margin-top: 0;\n  margin-bottom: 5px;\n}\n.list-group-item-text {\n  margin-bottom: 0;\n  line-height: 1.3;\n}\n","media.less":"// Media objects\n// Source: http://stubbornella.org/content/?p=497\n// --------------------------------------------------\n\n\n// Common styles\n// -------------------------\n\n// Clear the floats\n.media,\n.media-body {\n  overflow: hidden;\n  zoom: 1;\n}\n\n// Proper spacing between instances of .media\n.media,\n.media .media {\n  margin-top: 15px;\n}\n.media:first-child {\n  margin-top: 0;\n}\n\n// For images and videos, set to block\n.media-object {\n  display: block;\n}\n\n// Reset margins on headings for tighter default spacing\n.media-heading {\n  margin: 0 0 5px;\n}\n\n\n// Media image alignment\n// -------------------------\n\n.media {\n  > .pull-left {\n    margin-right: 10px;\n  }\n  > .pull-right {\n    margin-left: 10px;\n  }\n}\n\n\n// Media list variation\n// -------------------------\n\n// Undo default ul/ol styles\n.media-list {\n  padding-left: 0;\n  list-style: none;\n}\n","mixins.less":"//\n// Mixins\n// --------------------------------------------------\n\n\n// Utilities\n// -------------------------\n\n// Clearfix\n// Source: http://nicolasgallagher.com/micro-clearfix-hack/\n//\n// For modern browsers\n// 1. The space content is one way to avoid an Opera bug when the\n//    contenteditable attribute is included anywhere else in the document.\n//    Otherwise it causes space to appear at the top and bottom of elements\n//    that are clearfixed.\n// 2. The use of `table` rather than `block` is only necessary if using\n//    `:before` to contain the top-margins of child elements.\n.clearfix() {\n  &:before,\n  &:after {\n    content: \" \"; // 1\n    display: table; // 2\n  }\n  &:after {\n    clear: both;\n  }\n}\n\n// WebKit-style focus\n.tab-focus() {\n  // Default\n  outline: thin dotted;\n  // WebKit\n  outline: 5px auto -webkit-focus-ring-color;\n  outline-offset: -2px;\n}\n\n// Center-align a block level element\n.center-block() {\n  display: block;\n  margin-left: auto;\n  margin-right: auto;\n}\n\n// Sizing shortcuts\n.size(@width; @height) {\n  width: @width;\n  height: @height;\n}\n.square(@size) {\n  .size(@size; @size);\n}\n\n// Placeholder text\n.placeholder(@color: @input-color-placeholder) {\n  &::-moz-placeholder           { color: @color;   // Firefox\n                                  opacity: 1; } // See https://github.com/twbs/bootstrap/pull/11526\n  &:-ms-input-placeholder       { color: @color; } // Internet Explorer 10+\n  &::-webkit-input-placeholder  { color: @color; } // Safari and Chrome\n}\n\n// Text overflow\n// Requires inline-block or block for proper styling\n.text-overflow() {\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n// CSS image replacement\n//\n// Heads up! v3 launched with with only `.hide-text()`, but per our pattern for\n// mixins being reused as classes with the same name, this doesn't hold up. As\n// of v3.0.1 we have added `.text-hide()` and deprecated `.hide-text()`. Note\n// that we cannot chain the mixins together in Less, so they are repeated.\n//\n// Source: https://github.com/h5bp/html5-boilerplate/commit/aa0396eae757\n\n// Deprecated as of v3.0.1 (will be removed in v4)\n.hide-text() {\n  font: ~\"0/0\" a;\n  color: transparent;\n  text-shadow: none;\n  background-color: transparent;\n  border: 0;\n}\n// New mixin to use as of v3.0.1\n.text-hide() {\n  .hide-text();\n}\n\n\n\n// CSS3 PROPERTIES\n// --------------------------------------------------\n\n// Single side border-radius\n.border-top-radius(@radius) {\n  border-top-right-radius: @radius;\n   border-top-left-radius: @radius;\n}\n.border-right-radius(@radius) {\n  border-bottom-right-radius: @radius;\n     border-top-right-radius: @radius;\n}\n.border-bottom-radius(@radius) {\n  border-bottom-right-radius: @radius;\n   border-bottom-left-radius: @radius;\n}\n.border-left-radius(@radius) {\n  border-bottom-left-radius: @radius;\n     border-top-left-radius: @radius;\n}\n\n// Drop shadows\n//\n// Note: Deprecated `.box-shadow()` as of v3.1.0 since all of Bootstrap's\n//   supported browsers that have box shadow capabilities now support the\n//   standard `box-shadow` property.\n.box-shadow(@shadow) {\n  -webkit-box-shadow: @shadow; // iOS <4.3 & Android <4.1\n          box-shadow: @shadow;\n}\n\n// Transitions\n.transition(@transition) {\n  -webkit-transition: @transition;\n          transition: @transition;\n}\n.transition-property(@transition-property) {\n  -webkit-transition-property: @transition-property;\n          transition-property: @transition-property;\n}\n.transition-delay(@transition-delay) {\n  -webkit-transition-delay: @transition-delay;\n          transition-delay: @transition-delay;\n}\n.transition-duration(@transition-duration) {\n  -webkit-transition-duration: @transition-duration;\n          transition-duration: @transition-duration;\n}\n.transition-transform(@transition) {\n  -webkit-transition: -webkit-transform @transition;\n     -moz-transition: -moz-transform @transition;\n       -o-transition: -o-transform @transition;\n          transition: transform @transition;\n}\n\n// Transformations\n.rotate(@degrees) {\n  -webkit-transform: rotate(@degrees);\n      -ms-transform: rotate(@degrees); // IE9 only\n          transform: rotate(@degrees);\n}\n.scale(@ratio; @ratio-y...) {\n  -webkit-transform: scale(@ratio, @ratio-y);\n      -ms-transform: scale(@ratio, @ratio-y); // IE9 only\n          transform: scale(@ratio, @ratio-y);\n}\n.translate(@x; @y) {\n  -webkit-transform: translate(@x, @y);\n      -ms-transform: translate(@x, @y); // IE9 only\n          transform: translate(@x, @y);\n}\n.skew(@x; @y) {\n  -webkit-transform: skew(@x, @y);\n      -ms-transform: skewX(@x) skewY(@y); // See https://github.com/twbs/bootstrap/issues/4885; IE9+\n          transform: skew(@x, @y);\n}\n.translate3d(@x; @y; @z) {\n  -webkit-transform: translate3d(@x, @y, @z);\n          transform: translate3d(@x, @y, @z);\n}\n\n.rotateX(@degrees) {\n  -webkit-transform: rotateX(@degrees);\n      -ms-transform: rotateX(@degrees); // IE9 only\n          transform: rotateX(@degrees);\n}\n.rotateY(@degrees) {\n  -webkit-transform: rotateY(@degrees);\n      -ms-transform: rotateY(@degrees); // IE9 only\n          transform: rotateY(@degrees);\n}\n.perspective(@perspective) {\n  -webkit-perspective: @perspective;\n     -moz-perspective: @perspective;\n          perspective: @perspective;\n}\n.perspective-origin(@perspective) {\n  -webkit-perspective-origin: @perspective;\n     -moz-perspective-origin: @perspective;\n          perspective-origin: @perspective;\n}\n.transform-origin(@origin) {\n  -webkit-transform-origin: @origin;\n     -moz-transform-origin: @origin;\n      -ms-transform-origin: @origin; // IE9 only\n          transform-origin: @origin;\n}\n\n// Animations\n.animation(@animation) {\n  -webkit-animation: @animation;\n          animation: @animation;\n}\n.animation-name(@name) {\n  -webkit-animation-name: @name;\n          animation-name: @name;\n}\n.animation-duration(@duration) {\n  -webkit-animation-duration: @duration;\n          animation-duration: @duration;\n}\n.animation-timing-function(@timing-function) {\n  -webkit-animation-timing-function: @timing-function;\n          animation-timing-function: @timing-function;\n}\n.animation-delay(@delay) {\n  -webkit-animation-delay: @delay;\n          animation-delay: @delay;\n}\n.animation-iteration-count(@iteration-count) {\n  -webkit-animation-iteration-count: @iteration-count;\n          animation-iteration-count: @iteration-count;\n}\n.animation-direction(@direction) {\n  -webkit-animation-direction: @direction;\n          animation-direction: @direction;\n}\n\n// Backface visibility\n// Prevent browsers from flickering when using CSS 3D transforms.\n// Default value is `visible`, but can be changed to `hidden`\n.backface-visibility(@visibility){\n  -webkit-backface-visibility: @visibility;\n     -moz-backface-visibility: @visibility;\n          backface-visibility: @visibility;\n}\n\n// Box sizing\n.box-sizing(@boxmodel) {\n  -webkit-box-sizing: @boxmodel;\n     -moz-box-sizing: @boxmodel;\n          box-sizing: @boxmodel;\n}\n\n// User select\n// For selecting text on the page\n.user-select(@select) {\n  -webkit-user-select: @select;\n     -moz-user-select: @select;\n      -ms-user-select: @select; // IE10+\n          user-select: @select;\n}\n\n// Resize anything\n.resizable(@direction) {\n  resize: @direction; // Options: horizontal, vertical, both\n  overflow: auto; // Safari fix\n}\n\n// CSS3 Content Columns\n.content-columns(@column-count; @column-gap: @grid-gutter-width) {\n  -webkit-column-count: @column-count;\n     -moz-column-count: @column-count;\n          column-count: @column-count;\n  -webkit-column-gap: @column-gap;\n     -moz-column-gap: @column-gap;\n          column-gap: @column-gap;\n}\n\n// Optional hyphenation\n.hyphens(@mode: auto) {\n  word-wrap: break-word;\n  -webkit-hyphens: @mode;\n     -moz-hyphens: @mode;\n      -ms-hyphens: @mode; // IE10+\n       -o-hyphens: @mode;\n          hyphens: @mode;\n}\n\n// Opacity\n.opacity(@opacity) {\n  opacity: @opacity;\n  // IE8 filter\n  @opacity-ie: (@opacity * 100);\n  filter: ~\"alpha(opacity=@{opacity-ie})\";\n}\n\n\n\n// GRADIENTS\n// --------------------------------------------------\n\n#gradient {\n\n  // Horizontal gradient, from left to right\n  //\n  // Creates two color stops, start and end, by specifying a color and position for each color stop.\n  // Color stops are not available in IE9 and below.\n  .horizontal(@start-color: #555; @end-color: #333; @start-percent: 0%; @end-percent: 100%) {\n    background-image: -webkit-linear-gradient(left, color-stop(@start-color @start-percent), color-stop(@end-color @end-percent)); // Safari 5.1-6, Chrome 10+\n    background-image:  linear-gradient(to right, @start-color @start-percent, @end-color @end-percent); // Standard, IE10, Firefox 16+, Opera 12.10+, Safari 7+, Chrome 26+\n    background-repeat: repeat-x;\n    filter: e(%(\"progid:DXImageTransform.Microsoft.gradient(startColorstr='%d', endColorstr='%d', GradientType=1)\",argb(@start-color),argb(@end-color))); // IE9 and down\n  }\n\n  // Vertical gradient, from top to bottom\n  //\n  // Creates two color stops, start and end, by specifying a color and position for each color stop.\n  // Color stops are not available in IE9 and below.\n  .vertical(@start-color: #555; @end-color: #333; @start-percent: 0%; @end-percent: 100%) {\n    background-image: -webkit-linear-gradient(top, @start-color @start-percent, @end-color @end-percent);  // Safari 5.1-6, Chrome 10+\n    background-image: linear-gradient(to bottom, @start-color @start-percent, @end-color @end-percent); // Standard, IE10, Firefox 16+, Opera 12.10+, Safari 7+, Chrome 26+\n    background-repeat: repeat-x;\n    filter: e(%(\"progid:DXImageTransform.Microsoft.gradient(startColorstr='%d', endColorstr='%d', GradientType=0)\",argb(@start-color),argb(@end-color))); // IE9 and down\n  }\n\n  .directional(@start-color: #555; @end-color: #333; @deg: 45deg) {\n    background-repeat: repeat-x;\n    background-image: -webkit-linear-gradient(@deg, @start-color, @end-color); // Safari 5.1-6, Chrome 10+\n    background-image: linear-gradient(@deg, @start-color, @end-color); // Standard, IE10, Firefox 16+, Opera 12.10+, Safari 7+, Chrome 26+\n  }\n  .horizontal-three-colors(@start-color: #00b3ee; @mid-color: #7a43b6; @color-stop: 50%; @end-color: #c3325f) {\n    background-image: -webkit-linear-gradient(left, @start-color, @mid-color @color-stop, @end-color);\n    background-image: linear-gradient(to right, @start-color, @mid-color @color-stop, @end-color);\n    background-repeat: no-repeat;\n    filter: e(%(\"progid:DXImageTransform.Microsoft.gradient(startColorstr='%d', endColorstr='%d', GradientType=1)\",argb(@start-color),argb(@end-color))); // IE9 and down, gets no color-stop at all for proper fallback\n  }\n  .vertical-three-colors(@start-color: #00b3ee; @mid-color: #7a43b6; @color-stop: 50%; @end-color: #c3325f) {\n    background-image: -webkit-linear-gradient(@start-color, @mid-color @color-stop, @end-color);\n    background-image: linear-gradient(@start-color, @mid-color @color-stop, @end-color);\n    background-repeat: no-repeat;\n    filter: e(%(\"progid:DXImageTransform.Microsoft.gradient(startColorstr='%d', endColorstr='%d', GradientType=0)\",argb(@start-color),argb(@end-color))); // IE9 and down, gets no color-stop at all for proper fallback\n  }\n  .radial(@inner-color: #555; @outer-color: #333) {\n    background-image: -webkit-radial-gradient(circle, @inner-color, @outer-color);\n    background-image: radial-gradient(circle, @inner-color, @outer-color);\n    background-repeat: no-repeat;\n  }\n  .striped(@color: rgba(255,255,255,.15); @angle: 45deg) {\n    background-image: -webkit-linear-gradient(@angle, @color 25%, transparent 25%, transparent 50%, @color 50%, @color 75%, transparent 75%, transparent);\n    background-image: linear-gradient(@angle, @color 25%, transparent 25%, transparent 50%, @color 50%, @color 75%, transparent 75%, transparent);\n  }\n}\n\n// Reset filters for IE\n//\n// When you need to remove a gradient background, do not forget to use this to reset\n// the IE filter for IE9 and below.\n.reset-filter() {\n  filter: e(%(\"progid:DXImageTransform.Microsoft.gradient(enabled = false)\"));\n}\n\n\n\n// Retina images\n//\n// Short retina mixin for setting background-image and -size\n\n.img-retina(@file-1x; @file-2x; @width-1x; @height-1x) {\n  background-image: url(\"@{file-1x}\");\n\n  @media\n  only screen and (-webkit-min-device-pixel-ratio: 2),\n  only screen and (   min--moz-device-pixel-ratio: 2),\n  only screen and (     -o-min-device-pixel-ratio: 2/1),\n  only screen and (        min-device-pixel-ratio: 2),\n  only screen and (                min-resolution: 192dpi),\n  only screen and (                min-resolution: 2dppx) {\n    background-image: url(\"@{file-2x}\");\n    background-size: @width-1x @height-1x;\n  }\n}\n\n\n// Responsive image\n//\n// Keep images from scaling beyond the width of their parents.\n\n.img-responsive(@display: block) {\n  display: @display;\n  max-width: 100%; // Part 1: Set a maximum relative to the parent\n  height: auto; // Part 2: Scale the height according to the width, otherwise you get stretching\n}\n\n\n// COMPONENT MIXINS\n// --------------------------------------------------\n\n// Horizontal dividers\n// -------------------------\n// Dividers (basically an hr) within dropdowns and nav lists\n.nav-divider(@color: #e5e5e5) {\n  height: 1px;\n  margin: ((@line-height-computed / 2) - 1) 0;\n  overflow: hidden;\n  background-color: @color;\n}\n\n// Panels\n// -------------------------\n.panel-variant(@border; @heading-text-color; @heading-bg-color; @heading-border) {\n  border-color: @border;\n\n  & > .panel-heading {\n    color: @heading-text-color;\n    background-color: @heading-bg-color;\n    border-color: @heading-border;\n\n    + .panel-collapse .panel-body {\n      border-top-color: @border;\n    }\n  }\n  & > .panel-footer {\n    + .panel-collapse .panel-body {\n      border-bottom-color: @border;\n    }\n  }\n}\n\n// Alerts\n// -------------------------\n.alert-variant(@background; @border; @text-color) {\n  background-color: @background;\n  border-color: @border;\n  color: @text-color;\n\n  hr {\n    border-top-color: darken(@border, 5%);\n  }\n  .alert-link {\n    color: darken(@text-color, 10%);\n  }\n}\n\n// Tables\n// -------------------------\n.table-row-variant(@state; @background) {\n  // Exact selectors below required to override `.table-striped` and prevent\n  // inheritance to nested tables.\n  .table > thead > tr,\n  .table > tbody > tr,\n  .table > tfoot > tr {\n    > td.@{state},\n    > th.@{state},\n    &.@{state} > td,\n    &.@{state} > th {\n      background-color: @background;\n    }\n  }\n\n  // Hover states for `.table-hover`\n  // Note: this is not available for cells or rows within `thead` or `tfoot`.\n  .table-hover > tbody > tr {\n    > td.@{state}:hover,\n    > th.@{state}:hover,\n    &.@{state}:hover > td,\n    &.@{state}:hover > th {\n      background-color: darken(@background, 5%);\n    }\n  }\n}\n\n// List Groups\n// -------------------------\n.list-group-item-variant(@state; @background; @color) {\n  .list-group-item-@{state} {\n    color: @color;\n    background-color: @background;\n\n    a& {\n      color: @color;\n\n      .list-group-item-heading { color: inherit; }\n\n      &:hover,\n      &:focus {\n        color: @color;\n        background-color: darken(@background, 5%);\n      }\n      &.active,\n      &.active:hover,\n      &.active:focus {\n        color: #fff;\n        background-color: @color;\n        border-color: @color;\n      }\n    }\n  }\n}\n\n// Button variants\n// -------------------------\n// Easily pump out default styles, as well as :hover, :focus, :active,\n// and disabled options for all buttons\n.button-variant(@color; @background; @border) {\n  color: @color;\n  background-color: @background;\n  border-color: @border;\n\n  &:hover,\n  &:focus,\n  &:active,\n  &.active,\n  .open .dropdown-toggle& {\n    color: @color;\n    background-color: darken(@background, 8%);\n        border-color: darken(@border, 12%);\n  }\n  &:active,\n  &.active,\n  .open .dropdown-toggle& {\n    background-image: none;\n  }\n  &.disabled,\n  &[disabled],\n  fieldset[disabled] & {\n    &,\n    &:hover,\n    &:focus,\n    &:active,\n    &.active {\n      background-color: @background;\n          border-color: @border;\n    }\n  }\n\n  .badge {\n    color: @background;\n    background-color: @color;\n  }\n}\n\n// Button sizes\n// -------------------------\n.button-size(@padding-vertical; @padding-horizontal; @font-size; @line-height; @border-radius) {\n  padding: @padding-vertical @padding-horizontal;\n  font-size: @font-size;\n  line-height: @line-height;\n  border-radius: @border-radius;\n}\n\n// Pagination\n// -------------------------\n.pagination-size(@padding-vertical; @padding-horizontal; @font-size; @border-radius) {\n  > li {\n    > a,\n    > span {\n      padding: @padding-vertical @padding-horizontal;\n      font-size: @font-size;\n    }\n    &:first-child {\n      > a,\n      > span {\n        .border-left-radius(@border-radius);\n      }\n    }\n    &:last-child {\n      > a,\n      > span {\n        .border-right-radius(@border-radius);\n      }\n    }\n  }\n}\n\n// Labels\n// -------------------------\n.label-variant(@color) {\n  background-color: @color;\n  &[href] {\n    &:hover,\n    &:focus {\n      background-color: darken(@color, 10%);\n    }\n  }\n}\n\n// Contextual backgrounds\n// -------------------------\n.bg-variant(@color) {\n  background-color: @color;\n  a&:hover {\n    background-color: darken(@color, 10%);\n  }\n}\n\n// Typography\n// -------------------------\n.text-emphasis-variant(@color) {\n  color: @color;\n  a&:hover {\n    color: darken(@color, 10%);\n  }\n}\n\n// Navbar vertical align\n// -------------------------\n// Vertically center elements in the navbar.\n// Example: an element has a height of 30px, so write out `.navbar-vertical-align(30px);` to calculate the appropriate top margin.\n.navbar-vertical-align(@element-height) {\n  margin-top: ((@navbar-height - @element-height) / 2);\n  margin-bottom: ((@navbar-height - @element-height) / 2);\n}\n\n// Progress bars\n// -------------------------\n.progress-bar-variant(@color) {\n  background-color: @color;\n  .progress-striped & {\n    #gradient > .striped();\n  }\n}\n\n// Responsive utilities\n// -------------------------\n// More easily include all the states for responsive-utilities.less.\n.responsive-visibility() {\n  display: block !important;\n  table&  { display: table; }\n  tr&     { display: table-row !important; }\n  th&,\n  td&     { display: table-cell !important; }\n}\n\n.responsive-invisibility() {\n  display: none !important;\n}\n\n\n// Grid System\n// -----------\n\n// Centered container element\n.container-fixed() {\n  margin-right: auto;\n  margin-left: auto;\n  padding-left:  (@grid-gutter-width / 2);\n  padding-right: (@grid-gutter-width / 2);\n  &:extend(.clearfix all);\n}\n\n// Creates a wrapper for a series of columns\n.make-row(@gutter: @grid-gutter-width) {\n  margin-left:  (@gutter / -2);\n  margin-right: (@gutter / -2);\n  &:extend(.clearfix all);\n}\n\n// Generate the extra small columns\n.make-xs-column(@columns; @gutter: @grid-gutter-width) {\n  position: relative;\n  float: left;\n  width: percentage((@columns / @grid-columns));\n  min-height: 1px;\n  padding-left:  (@gutter / 2);\n  padding-right: (@gutter / 2);\n}\n.make-xs-column-offset(@columns) {\n  @media (min-width: @screen-xs-min) {\n    margin-left: percentage((@columns / @grid-columns));\n  }\n}\n.make-xs-column-push(@columns) {\n  @media (min-width: @screen-xs-min) {\n    left: percentage((@columns / @grid-columns));\n  }\n}\n.make-xs-column-pull(@columns) {\n  @media (min-width: @screen-xs-min) {\n    right: percentage((@columns / @grid-columns));\n  }\n}\n\n\n// Generate the small columns\n.make-sm-column(@columns; @gutter: @grid-gutter-width) {\n  position: relative;\n  min-height: 1px;\n  padding-left:  (@gutter / 2);\n  padding-right: (@gutter / 2);\n\n  @media (min-width: @screen-sm-min) {\n    float: left;\n    width: percentage((@columns / @grid-columns));\n  }\n}\n.make-sm-column-offset(@columns) {\n  @media (min-width: @screen-sm-min) {\n    margin-left: percentage((@columns / @grid-columns));\n  }\n}\n.make-sm-column-push(@columns) {\n  @media (min-width: @screen-sm-min) {\n    left: percentage((@columns / @grid-columns));\n  }\n}\n.make-sm-column-pull(@columns) {\n  @media (min-width: @screen-sm-min) {\n    right: percentage((@columns / @grid-columns));\n  }\n}\n\n\n// Generate the medium columns\n.make-md-column(@columns; @gutter: @grid-gutter-width) {\n  position: relative;\n  min-height: 1px;\n  padding-left:  (@gutter / 2);\n  padding-right: (@gutter / 2);\n\n  @media (min-width: @screen-md-min) {\n    float: left;\n    width: percentage((@columns / @grid-columns));\n  }\n}\n.make-md-column-offset(@columns) {\n  @media (min-width: @screen-md-min) {\n    margin-left: percentage((@columns / @grid-columns));\n  }\n}\n.make-md-column-push(@columns) {\n  @media (min-width: @screen-md-min) {\n    left: percentage((@columns / @grid-columns));\n  }\n}\n.make-md-column-pull(@columns) {\n  @media (min-width: @screen-md-min) {\n    right: percentage((@columns / @grid-columns));\n  }\n}\n\n\n// Generate the large columns\n.make-lg-column(@columns; @gutter: @grid-gutter-width) {\n  position: relative;\n  min-height: 1px;\n  padding-left:  (@gutter / 2);\n  padding-right: (@gutter / 2);\n\n  @media (min-width: @screen-lg-min) {\n    float: left;\n    width: percentage((@columns / @grid-columns));\n  }\n}\n.make-lg-column-offset(@columns) {\n  @media (min-width: @screen-lg-min) {\n    margin-left: percentage((@columns / @grid-columns));\n  }\n}\n.make-lg-column-push(@columns) {\n  @media (min-width: @screen-lg-min) {\n    left: percentage((@columns / @grid-columns));\n  }\n}\n.make-lg-column-pull(@columns) {\n  @media (min-width: @screen-lg-min) {\n    right: percentage((@columns / @grid-columns));\n  }\n}\n\n\n// Framework grid generation\n//\n// Used only by Bootstrap to generate the correct number of grid classes given\n// any value of `@grid-columns`.\n\n.make-grid-columns() {\n  // Common styles for all sizes of grid columns, widths 1-12\n  .col(@index) when (@index = 1) { // initial\n    @item: ~\".col-xs-@{index}, .col-sm-@{index}, .col-md-@{index}, .col-lg-@{index}\";\n    .col((@index + 1), @item);\n  }\n  .col(@index, @list) when (@index =< @grid-columns) { // general; \"=<\" isn't a typo\n    @item: ~\".col-xs-@{index}, .col-sm-@{index}, .col-md-@{index}, .col-lg-@{index}\";\n    .col((@index + 1), ~\"@{list}, @{item}\");\n  }\n  .col(@index, @list) when (@index > @grid-columns) { // terminal\n    @{list} {\n      position: relative;\n      // Prevent columns from collapsing when empty\n      min-height: 1px;\n      // Inner gutter via padding\n      padding-left:  (@grid-gutter-width / 2);\n      padding-right: (@grid-gutter-width / 2);\n    }\n  }\n  .col(1); // kickstart it\n}\n\n.float-grid-columns(@class) {\n  .col(@index) when (@index = 1) { // initial\n    @item: ~\".col-@{class}-@{index}\";\n    .col((@index + 1), @item);\n  }\n  .col(@index, @list) when (@index =< @grid-columns) { // general\n    @item: ~\".col-@{class}-@{index}\";\n    .col((@index + 1), ~\"@{list}, @{item}\");\n  }\n  .col(@index, @list) when (@index > @grid-columns) { // terminal\n    @{list} {\n      float: left;\n    }\n  }\n  .col(1); // kickstart it\n}\n\n.calc-grid-column(@index, @class, @type) when (@type = width) and (@index > 0) {\n  .col-@{class}-@{index} {\n    width: percentage((@index / @grid-columns));\n  }\n}\n.calc-grid-column(@index, @class, @type) when (@type = push) {\n  .col-@{class}-push-@{index} {\n    left: percentage((@index / @grid-columns));\n  }\n}\n.calc-grid-column(@index, @class, @type) when (@type = pull) {\n  .col-@{class}-pull-@{index} {\n    right: percentage((@index / @grid-columns));\n  }\n}\n.calc-grid-column(@index, @class, @type) when (@type = offset) {\n  .col-@{class}-offset-@{index} {\n    margin-left: percentage((@index / @grid-columns));\n  }\n}\n\n// Basic looping in LESS\n.loop-grid-columns(@index, @class, @type) when (@index >= 0) {\n  .calc-grid-column(@index, @class, @type);\n  // next iteration\n  .loop-grid-columns((@index - 1), @class, @type);\n}\n\n// Create grid for specific class\n.make-grid(@class) {\n  .float-grid-columns(@class);\n  .loop-grid-columns(@grid-columns, @class, width);\n  .loop-grid-columns(@grid-columns, @class, pull);\n  .loop-grid-columns(@grid-columns, @class, push);\n  .loop-grid-columns(@grid-columns, @class, offset);\n}\n\n// Form validation states\n//\n// Used in forms.less to generate the form validation CSS for warnings, errors,\n// and successes.\n\n.form-control-validation(@text-color: #555; @border-color: #ccc; @background-color: #f5f5f5) {\n  // Color the label and help text\n  .help-block,\n  .control-label,\n  .radio,\n  .checkbox,\n  .radio-inline,\n  .checkbox-inline  {\n    color: @text-color;\n  }\n  // Set the border and box shadow on specific inputs to match\n  .form-control {\n    border-color: @border-color;\n    .box-shadow(inset 0 1px 1px rgba(0,0,0,.075)); // Redeclare so transitions work\n    &:focus {\n      border-color: darken(@border-color, 10%);\n      @shadow: inset 0 1px 1px rgba(0,0,0,.075), 0 0 6px lighten(@border-color, 20%);\n      .box-shadow(@shadow);\n    }\n  }\n  // Set validation states also for addons\n  .input-group-addon {\n    color: @text-color;\n    border-color: @border-color;\n    background-color: @background-color;\n  }\n  // Optional feedback icon\n  .form-control-feedback {\n    color: @text-color;\n  }\n}\n\n// Form control focus state\n//\n// Generate a customized focus state and for any input with the specified color,\n// which defaults to the `@input-focus-border` variable.\n//\n// We highly encourage you to not customize the default value, but instead use\n// this to tweak colors on an as-needed basis. This aesthetic change is based on\n// WebKit's default styles, but applicable to a wider range of browsers. Its\n// usability and accessibility should be taken into account with any change.\n//\n// Example usage: change the default blue border and shadow to white for better\n// contrast against a dark gray background.\n\n.form-control-focus(@color: @input-border-focus) {\n  @color-rgba: rgba(red(@color), green(@color), blue(@color), .6);\n  &:focus {\n    border-color: @color;\n    outline: 0;\n    .box-shadow(~\"inset 0 1px 1px rgba(0,0,0,.075), 0 0 8px @{color-rgba}\");\n  }\n}\n\n// Form control sizing\n//\n// Relative text size, padding, and border-radii changes for form controls. For\n// horizontal sizing, wrap controls in the predefined grid classes. `<select>`\n// element gets special love because it's special, and that's a fact!\n\n.input-size(@input-height; @padding-vertical; @padding-horizontal; @font-size; @line-height; @border-radius) {\n  height: @input-height;\n  padding: @padding-vertical @padding-horizontal;\n  font-size: @font-size;\n  line-height: @line-height;\n  border-radius: @border-radius;\n\n  select& {\n    height: @input-height;\n    line-height: @input-height;\n  }\n\n  textarea&,\n  select[multiple]& {\n    height: auto;\n  }\n}\n","modals.less":"//\n// Modals\n// --------------------------------------------------\n\n// .modal-open      - body class for killing the scroll\n// .modal           - container to scroll within\n// .modal-dialog    - positioning shell for the actual modal\n// .modal-content   - actual modal w/ bg and corners and shit\n\n// Kill the scroll on the body\n.modal-open {\n  overflow: hidden;\n}\n\n// Container that the modal scrolls within\n.modal {\n  display: none;\n  overflow: auto;\n  overflow-y: scroll;\n  position: fixed;\n  top: 0;\n  right: 0;\n  bottom: 0;\n  left: 0;\n  z-index: @zindex-modal;\n  -webkit-overflow-scrolling: touch;\n\n  // Prevent Chrome on Windows from adding a focus outline. For details, see\n  // https://github.com/twbs/bootstrap/pull/10951.\n  outline: 0;\n\n  // When fading in the modal, animate it to slide down\n  &.fade .modal-dialog {\n    .translate(0, -25%);\n    .transition-transform(~\"0.3s ease-out\");\n  }\n  &.in .modal-dialog { .translate(0, 0)}\n}\n\n// Shell div to position the modal with bottom padding\n.modal-dialog {\n  position: relative;\n  width: auto;\n  margin: 10px;\n}\n\n// Actual modal\n.modal-content {\n  position: relative;\n  background-color: @modal-content-bg;\n  border: 1px solid @modal-content-fallback-border-color; //old browsers fallback (ie8 etc)\n  border: 1px solid @modal-content-border-color;\n  border-radius: @border-radius-large;\n  .box-shadow(0 3px 9px rgba(0,0,0,.5));\n  background-clip: padding-box;\n  // Remove focus outline from opened modal\n  outline: none;\n}\n\n// Modal background\n.modal-backdrop {\n  position: fixed;\n  top: 0;\n  right: 0;\n  bottom: 0;\n  left: 0;\n  z-index: @zindex-modal-background;\n  background-color: @modal-backdrop-bg;\n  // Fade for backdrop\n  &.fade { .opacity(0); }\n  &.in { .opacity(@modal-backdrop-opacity); }\n}\n\n// Modal header\n// Top section of the modal w/ title and dismiss\n.modal-header {\n  padding: @modal-title-padding;\n  border-bottom: 1px solid @modal-header-border-color;\n  min-height: (@modal-title-padding + @modal-title-line-height);\n}\n// Close icon\n.modal-header .close {\n  margin-top: -2px;\n}\n\n// Title text within header\n.modal-title {\n  margin: 0;\n  line-height: @modal-title-line-height;\n}\n\n// Modal body\n// Where all modal content resides (sibling of .modal-header and .modal-footer)\n.modal-body {\n  position: relative;\n  padding: @modal-inner-padding;\n}\n\n// Footer (for actions)\n.modal-footer {\n  margin-top: 15px;\n  padding: (@modal-inner-padding - 1) @modal-inner-padding @modal-inner-padding;\n  text-align: right; // right align buttons\n  border-top: 1px solid @modal-footer-border-color;\n  &:extend(.clearfix all); // clear it in case folks use .pull-* classes on buttons\n\n  // Properly space out buttons\n  .btn + .btn {\n    margin-left: 5px;\n    margin-bottom: 0; // account for input[type=\"submit\"] which gets the bottom margin like all other inputs\n  }\n  // but override that for button groups\n  .btn-group .btn + .btn {\n    margin-left: -1px;\n  }\n  // and override it for block buttons as well\n  .btn-block + .btn-block {\n    margin-left: 0;\n  }\n}\n\n// Scale up the modal\n@media (min-width: @screen-sm-min) {\n  // Automatically set modal's width for larger viewports\n  .modal-dialog {\n    width: @modal-md;\n    margin: 30px auto;\n  }\n  .modal-content {\n    .box-shadow(0 5px 15px rgba(0,0,0,.5));\n  }\n\n  // Modal sizes\n  .modal-sm { width: @modal-sm; }\n}\n\n@media (min-width: @screen-md-min) {\n  .modal-lg { width: @modal-lg; }\n}\n","navbar.less":"//\n// Navbars\n// --------------------------------------------------\n\n\n// Wrapper and base class\n//\n// Provide a static navbar from which we expand to create full-width, fixed, and\n// other navbar variations.\n\n.navbar {\n  position: relative;\n  min-height: @navbar-height; // Ensure a navbar always shows (e.g., without a .navbar-brand in collapsed mode)\n  margin-bottom: @navbar-margin-bottom;\n  border: 1px solid transparent;\n\n  // Prevent floats from breaking the navbar\n  &:extend(.clearfix all);\n\n  @media (min-width: @grid-float-breakpoint) {\n    border-radius: @navbar-border-radius;\n  }\n}\n\n\n// Navbar heading\n//\n// Groups `.navbar-brand` and `.navbar-toggle` into a single component for easy\n// styling of responsive aspects.\n\n.navbar-header {\n  &:extend(.clearfix all);\n\n  @media (min-width: @grid-float-breakpoint) {\n    float: left;\n  }\n}\n\n\n// Navbar collapse (body)\n//\n// Group your navbar content into this for easy collapsing and expanding across\n// various device sizes. By default, this content is collapsed when <768px, but\n// will expand past that for a horizontal display.\n//\n// To start (on mobile devices) the navbar links, forms, and buttons are stacked\n// vertically and include a `max-height` to overflow in case you have too much\n// content for the user's viewport.\n\n.navbar-collapse {\n  max-height: @navbar-collapse-max-height;\n  overflow-x: visible;\n  padding-right: @navbar-padding-horizontal;\n  padding-left:  @navbar-padding-horizontal;\n  border-top: 1px solid transparent;\n  box-shadow: inset 0 1px 0 rgba(255,255,255,.1);\n  &:extend(.clearfix all);\n  -webkit-overflow-scrolling: touch;\n\n  &.in {\n    overflow-y: auto;\n  }\n\n  @media (min-width: @grid-float-breakpoint) {\n    width: auto;\n    border-top: 0;\n    box-shadow: none;\n\n    &.collapse {\n      display: block !important;\n      height: auto !important;\n      padding-bottom: 0; // Override default setting\n      overflow: visible !important;\n    }\n\n    &.in {\n      overflow-y: visible;\n    }\n\n    // Undo the collapse side padding for navbars with containers to ensure\n    // alignment of right-aligned contents.\n    .navbar-fixed-top &,\n    .navbar-static-top &,\n    .navbar-fixed-bottom & {\n      padding-left: 0;\n      padding-right: 0;\n    }\n  }\n}\n\n\n// Both navbar header and collapse\n//\n// When a container is present, change the behavior of the header and collapse.\n\n.container,\n.container-fluid {\n  > .navbar-header,\n  > .navbar-collapse {\n    margin-right: -@navbar-padding-horizontal;\n    margin-left:  -@navbar-padding-horizontal;\n\n    @media (min-width: @grid-float-breakpoint) {\n      margin-right: 0;\n      margin-left:  0;\n    }\n  }\n}\n\n\n//\n// Navbar alignment options\n//\n// Display the navbar across the entirety of the page or fixed it to the top or\n// bottom of the page.\n\n// Static top (unfixed, but 100% wide) navbar\n.navbar-static-top {\n  z-index: @zindex-navbar;\n  border-width: 0 0 1px;\n\n  @media (min-width: @grid-float-breakpoint) {\n    border-radius: 0;\n  }\n}\n\n// Fix the top/bottom navbars when screen real estate supports it\n.navbar-fixed-top,\n.navbar-fixed-bottom {\n  position: fixed;\n  right: 0;\n  left: 0;\n  z-index: @zindex-navbar-fixed;\n\n  // Undo the rounded corners\n  @media (min-width: @grid-float-breakpoint) {\n    border-radius: 0;\n  }\n}\n.navbar-fixed-top {\n  top: 0;\n  border-width: 0 0 1px;\n}\n.navbar-fixed-bottom {\n  bottom: 0;\n  margin-bottom: 0; // override .navbar defaults\n  border-width: 1px 0 0;\n}\n\n\n// Brand/project name\n\n.navbar-brand {\n  float: left;\n  padding: @navbar-padding-vertical @navbar-padding-horizontal;\n  font-size: @font-size-large;\n  line-height: @line-height-computed;\n  height: @navbar-height;\n\n  &:hover,\n  &:focus {\n    text-decoration: none;\n  }\n\n  @media (min-width: @grid-float-breakpoint) {\n    .navbar > .container &,\n    .navbar > .container-fluid & {\n      margin-left: -@navbar-padding-horizontal;\n    }\n  }\n}\n\n\n// Navbar toggle\n//\n// Custom button for toggling the `.navbar-collapse`, powered by the collapse\n// JavaScript plugin.\n\n.navbar-toggle {\n  position: relative;\n  float: right;\n  margin-right: @navbar-padding-horizontal;\n  padding: 9px 10px;\n  .navbar-vertical-align(34px);\n  background-color: transparent;\n  background-image: none; // Reset unusual Firefox-on-Android default style; see https://github.com/necolas/normalize.css/issues/214\n  border: 1px solid transparent;\n  border-radius: @border-radius-base;\n\n  // We remove the `outline` here, but later compensate by attaching `:hover`\n  // styles to `:focus`.\n  &:focus {\n    outline: none;\n  }\n\n  // Bars\n  .icon-bar {\n    display: block;\n    width: 22px;\n    height: 2px;\n    border-radius: 1px;\n  }\n  .icon-bar + .icon-bar {\n    margin-top: 4px;\n  }\n\n  @media (min-width: @grid-float-breakpoint) {\n    display: none;\n  }\n}\n\n\n// Navbar nav links\n//\n// Builds on top of the `.nav` components with its own modifier class to make\n// the nav the full height of the horizontal nav (above 768px).\n\n.navbar-nav {\n  margin: (@navbar-padding-vertical / 2) -@navbar-padding-horizontal;\n\n  > li > a {\n    padding-top:    10px;\n    padding-bottom: 10px;\n    line-height: @line-height-computed;\n  }\n\n  @media (max-width: @grid-float-breakpoint-max) {\n    // Dropdowns get custom display when collapsed\n    .open .dropdown-menu {\n      position: static;\n      float: none;\n      width: auto;\n      margin-top: 0;\n      background-color: transparent;\n      border: 0;\n      box-shadow: none;\n      > li > a,\n      .dropdown-header {\n        padding: 5px 15px 5px 25px;\n      }\n      > li > a {\n        line-height: @line-height-computed;\n        &:hover,\n        &:focus {\n          background-image: none;\n        }\n      }\n    }\n  }\n\n  // Uncollapse the nav\n  @media (min-width: @grid-float-breakpoint) {\n    float: left;\n    margin: 0;\n\n    > li {\n      float: left;\n      > a {\n        padding-top:    @navbar-padding-vertical;\n        padding-bottom: @navbar-padding-vertical;\n      }\n    }\n\n    &.navbar-right:last-child {\n      margin-right: -@navbar-padding-horizontal;\n    }\n  }\n}\n\n\n// Component alignment\n//\n// Repurpose the pull utilities as their own navbar utilities to avoid specificity\n// issues with parents and chaining. Only do this when the navbar is uncollapsed\n// though so that navbar contents properly stack and align in mobile.\n\n@media (min-width: @grid-float-breakpoint) {\n  .navbar-left  { .pull-left(); }\n  .navbar-right { .pull-right(); }\n}\n\n\n// Navbar form\n//\n// Extension of the `.form-inline` with some extra flavor for optimum display in\n// our navbars.\n\n.navbar-form {\n  margin-left: -@navbar-padding-horizontal;\n  margin-right: -@navbar-padding-horizontal;\n  padding: 10px @navbar-padding-horizontal;\n  border-top: 1px solid transparent;\n  border-bottom: 1px solid transparent;\n  @shadow: inset 0 1px 0 rgba(255,255,255,.1), 0 1px 0 rgba(255,255,255,.1);\n  .box-shadow(@shadow);\n\n  // Mixin behavior for optimum display\n  .form-inline();\n\n  .form-group {\n    @media (max-width: @grid-float-breakpoint-max) {\n      margin-bottom: 5px;\n    }\n  }\n\n  // Vertically center in expanded, horizontal navbar\n  .navbar-vertical-align(@input-height-base);\n\n  // Undo 100% width for pull classes\n  @media (min-width: @grid-float-breakpoint) {\n    width: auto;\n    border: 0;\n    margin-left: 0;\n    margin-right: 0;\n    padding-top: 0;\n    padding-bottom: 0;\n    .box-shadow(none);\n\n    // Outdent the form if last child to line up with content down the page\n    &.navbar-right:last-child {\n      margin-right: -@navbar-padding-horizontal;\n    }\n  }\n}\n\n\n// Dropdown menus\n\n// Menu position and menu carets\n.navbar-nav > li > .dropdown-menu {\n  margin-top: 0;\n  .border-top-radius(0);\n}\n// Menu position and menu caret support for dropups via extra dropup class\n.navbar-fixed-bottom .navbar-nav > li > .dropdown-menu {\n  .border-bottom-radius(0);\n}\n\n\n// Buttons in navbars\n//\n// Vertically center a button within a navbar (when *not* in a form).\n\n.navbar-btn {\n  .navbar-vertical-align(@input-height-base);\n\n  &.btn-sm {\n    .navbar-vertical-align(@input-height-small);\n  }\n  &.btn-xs {\n    .navbar-vertical-align(22);\n  }\n}\n\n\n// Text in navbars\n//\n// Add a class to make any element properly align itself vertically within the navbars.\n\n.navbar-text {\n  .navbar-vertical-align(@line-height-computed);\n\n  @media (min-width: @grid-float-breakpoint) {\n    float: left;\n    margin-left: @navbar-padding-horizontal;\n    margin-right: @navbar-padding-horizontal;\n\n    // Outdent the form if last child to line up with content down the page\n    &.navbar-right:last-child {\n      margin-right: 0;\n    }\n  }\n}\n\n// Alternate navbars\n// --------------------------------------------------\n\n// Default navbar\n.navbar-default {\n  background-color: @navbar-default-bg;\n  border-color: @navbar-default-border;\n\n  .navbar-brand {\n    color: @navbar-default-brand-color;\n    &:hover,\n    &:focus {\n      color: @navbar-default-brand-hover-color;\n      background-color: @navbar-default-brand-hover-bg;\n    }\n  }\n\n  .navbar-text {\n    color: @navbar-default-color;\n  }\n\n  .navbar-nav {\n    > li > a {\n      color: @navbar-default-link-color;\n\n      &:hover,\n      &:focus {\n        color: @navbar-default-link-hover-color;\n        background-color: @navbar-default-link-hover-bg;\n      }\n    }\n    > .active > a {\n      &,\n      &:hover,\n      &:focus {\n        color: @navbar-default-link-active-color;\n        background-color: @navbar-default-link-active-bg;\n      }\n    }\n    > .disabled > a {\n      &,\n      &:hover,\n      &:focus {\n        color: @navbar-default-link-disabled-color;\n        background-color: @navbar-default-link-disabled-bg;\n      }\n    }\n  }\n\n  .navbar-toggle {\n    border-color: @navbar-default-toggle-border-color;\n    &:hover,\n    &:focus {\n      background-color: @navbar-default-toggle-hover-bg;\n    }\n    .icon-bar {\n      background-color: @navbar-default-toggle-icon-bar-bg;\n    }\n  }\n\n  .navbar-collapse,\n  .navbar-form {\n    border-color: @navbar-default-border;\n  }\n\n  // Dropdown menu items\n  .navbar-nav {\n    // Remove background color from open dropdown\n    > .open > a {\n      &,\n      &:hover,\n      &:focus {\n        background-color: @navbar-default-link-active-bg;\n        color: @navbar-default-link-active-color;\n      }\n    }\n\n    @media (max-width: @grid-float-breakpoint-max) {\n      // Dropdowns get custom display when collapsed\n      .open .dropdown-menu {\n        > li > a {\n          color: @navbar-default-link-color;\n          &:hover,\n          &:focus {\n            color: @navbar-default-link-hover-color;\n            background-color: @navbar-default-link-hover-bg;\n          }\n        }\n        > .active > a {\n          &,\n          &:hover,\n          &:focus {\n            color: @navbar-default-link-active-color;\n            background-color: @navbar-default-link-active-bg;\n          }\n        }\n        > .disabled > a {\n          &,\n          &:hover,\n          &:focus {\n            color: @navbar-default-link-disabled-color;\n            background-color: @navbar-default-link-disabled-bg;\n          }\n        }\n      }\n    }\n  }\n\n\n  // Links in navbars\n  //\n  // Add a class to ensure links outside the navbar nav are colored correctly.\n\n  .navbar-link {\n    color: @navbar-default-link-color;\n    &:hover {\n      color: @navbar-default-link-hover-color;\n    }\n  }\n\n}\n\n// Inverse navbar\n\n.navbar-inverse {\n  background-color: @navbar-inverse-bg;\n  border-color: @navbar-inverse-border;\n\n  .navbar-brand {\n    color: @navbar-inverse-brand-color;\n    &:hover,\n    &:focus {\n      color: @navbar-inverse-brand-hover-color;\n      background-color: @navbar-inverse-brand-hover-bg;\n    }\n  }\n\n  .navbar-text {\n    color: @navbar-inverse-color;\n  }\n\n  .navbar-nav {\n    > li > a {\n      color: @navbar-inverse-link-color;\n\n      &:hover,\n      &:focus {\n        color: @navbar-inverse-link-hover-color;\n        background-color: @navbar-inverse-link-hover-bg;\n      }\n    }\n    > .active > a {\n      &,\n      &:hover,\n      &:focus {\n        color: @navbar-inverse-link-active-color;\n        background-color: @navbar-inverse-link-active-bg;\n      }\n    }\n    > .disabled > a {\n      &,\n      &:hover,\n      &:focus {\n        color: @navbar-inverse-link-disabled-color;\n        background-color: @navbar-inverse-link-disabled-bg;\n      }\n    }\n  }\n\n  // Darken the responsive nav toggle\n  .navbar-toggle {\n    border-color: @navbar-inverse-toggle-border-color;\n    &:hover,\n    &:focus {\n      background-color: @navbar-inverse-toggle-hover-bg;\n    }\n    .icon-bar {\n      background-color: @navbar-inverse-toggle-icon-bar-bg;\n    }\n  }\n\n  .navbar-collapse,\n  .navbar-form {\n    border-color: darken(@navbar-inverse-bg, 7%);\n  }\n\n  // Dropdowns\n  .navbar-nav {\n    > .open > a {\n      &,\n      &:hover,\n      &:focus {\n        background-color: @navbar-inverse-link-active-bg;\n        color: @navbar-inverse-link-active-color;\n      }\n    }\n\n    @media (max-width: @grid-float-breakpoint-max) {\n      // Dropdowns get custom display\n      .open .dropdown-menu {\n        > .dropdown-header {\n          border-color: @navbar-inverse-border;\n        }\n        .divider {\n          background-color: @navbar-inverse-border;\n        }\n        > li > a {\n          color: @navbar-inverse-link-color;\n          &:hover,\n          &:focus {\n            color: @navbar-inverse-link-hover-color;\n            background-color: @navbar-inverse-link-hover-bg;\n          }\n        }\n        > .active > a {\n          &,\n          &:hover,\n          &:focus {\n            color: @navbar-inverse-link-active-color;\n            background-color: @navbar-inverse-link-active-bg;\n          }\n        }\n        > .disabled > a {\n          &,\n          &:hover,\n          &:focus {\n            color: @navbar-inverse-link-disabled-color;\n            background-color: @navbar-inverse-link-disabled-bg;\n          }\n        }\n      }\n    }\n  }\n\n  .navbar-link {\n    color: @navbar-inverse-link-color;\n    &:hover {\n      color: @navbar-inverse-link-hover-color;\n    }\n  }\n\n}\n","navs.less":"//\n// Navs\n// --------------------------------------------------\n\n\n// Base class\n// --------------------------------------------------\n\n.nav {\n  margin-bottom: 0;\n  padding-left: 0; // Override default ul/ol\n  list-style: none;\n  &:extend(.clearfix all);\n\n  > li {\n    position: relative;\n    display: block;\n\n    > a {\n      position: relative;\n      display: block;\n      padding: @nav-link-padding;\n      &:hover,\n      &:focus {\n        text-decoration: none;\n        background-color: @nav-link-hover-bg;\n      }\n    }\n\n    // Disabled state sets text to gray and nukes hover/tab effects\n    &.disabled > a {\n      color: @nav-disabled-link-color;\n\n      &:hover,\n      &:focus {\n        color: @nav-disabled-link-hover-color;\n        text-decoration: none;\n        background-color: transparent;\n        cursor: not-allowed;\n      }\n    }\n  }\n\n  // Open dropdowns\n  .open > a {\n    &,\n    &:hover,\n    &:focus {\n      background-color: @nav-link-hover-bg;\n      border-color: @link-color;\n    }\n  }\n\n  // Nav dividers (deprecated with v3.0.1)\n  //\n  // This should have been removed in v3 with the dropping of `.nav-list`, but\n  // we missed it. We don't currently support this anywhere, but in the interest\n  // of maintaining backward compatibility in case you use it, it's deprecated.\n  .nav-divider {\n    .nav-divider();\n  }\n\n  // Prevent IE8 from misplacing imgs\n  //\n  // See https://github.com/h5bp/html5-boilerplate/issues/984#issuecomment-3985989\n  > li > a > img {\n    max-width: none;\n  }\n}\n\n\n// Tabs\n// -------------------------\n\n// Give the tabs something to sit on\n.nav-tabs {\n  border-bottom: 1px solid @nav-tabs-border-color;\n  > li {\n    float: left;\n    // Make the list-items overlay the bottom border\n    margin-bottom: -1px;\n\n    // Actual tabs (as links)\n    > a {\n      margin-right: 2px;\n      line-height: @line-height-base;\n      border: 1px solid transparent;\n      border-radius: @border-radius-base @border-radius-base 0 0;\n      &:hover {\n        border-color: @nav-tabs-link-hover-border-color @nav-tabs-link-hover-border-color @nav-tabs-border-color;\n      }\n    }\n\n    // Active state, and its :hover to override normal :hover\n    &.active > a {\n      &,\n      &:hover,\n      &:focus {\n        color: @nav-tabs-active-link-hover-color;\n        background-color: @nav-tabs-active-link-hover-bg;\n        border: 1px solid @nav-tabs-active-link-hover-border-color;\n        border-bottom-color: transparent;\n        cursor: default;\n      }\n    }\n  }\n  // pulling this in mainly for less shorthand\n  &.nav-justified {\n    .nav-justified();\n    .nav-tabs-justified();\n  }\n}\n\n\n// Pills\n// -------------------------\n.nav-pills {\n  > li {\n    float: left;\n\n    // Links rendered as pills\n    > a {\n      border-radius: @nav-pills-border-radius;\n    }\n    + li {\n      margin-left: 2px;\n    }\n\n    // Active state\n    &.active > a {\n      &,\n      &:hover,\n      &:focus {\n        color: @nav-pills-active-link-hover-color;\n        background-color: @nav-pills-active-link-hover-bg;\n      }\n    }\n  }\n}\n\n\n// Stacked pills\n.nav-stacked {\n  > li {\n    float: none;\n    + li {\n      margin-top: 2px;\n      margin-left: 0; // no need for this gap between nav items\n    }\n  }\n}\n\n\n// Nav variations\n// --------------------------------------------------\n\n// Justified nav links\n// -------------------------\n\n.nav-justified {\n  width: 100%;\n\n  > li {\n    float: none;\n     > a {\n      text-align: center;\n      margin-bottom: 5px;\n    }\n  }\n\n  > .dropdown .dropdown-menu {\n    top: auto;\n    left: auto;\n  }\n\n  @media (min-width: @screen-sm-min) {\n    > li {\n      display: table-cell;\n      width: 1%;\n      > a {\n        margin-bottom: 0;\n      }\n    }\n  }\n}\n\n// Move borders to anchors instead of bottom of list\n//\n// Mixin for adding on top the shared `.nav-justified` styles for our tabs\n.nav-tabs-justified {\n  border-bottom: 0;\n\n  > li > a {\n    // Override margin from .nav-tabs\n    margin-right: 0;\n    border-radius: @border-radius-base;\n  }\n\n  > .active > a,\n  > .active > a:hover,\n  > .active > a:focus {\n    border: 1px solid @nav-tabs-justified-link-border-color;\n  }\n\n  @media (min-width: @screen-sm-min) {\n    > li > a {\n      border-bottom: 1px solid @nav-tabs-justified-link-border-color;\n      border-radius: @border-radius-base @border-radius-base 0 0;\n    }\n    > .active > a,\n    > .active > a:hover,\n    > .active > a:focus {\n      border-bottom-color: @nav-tabs-justified-active-link-border-color;\n    }\n  }\n}\n\n\n// Tabbable tabs\n// -------------------------\n\n// Hide tabbable panes to start, show them when `.active`\n.tab-content {\n  > .tab-pane {\n    display: none;\n  }\n  > .active {\n    display: block;\n  }\n}\n\n\n// Dropdowns\n// -------------------------\n\n// Specific dropdowns\n.nav-tabs .dropdown-menu {\n  // make dropdown border overlap tab border\n  margin-top: -1px;\n  // Remove the top rounded corners here since there is a hard edge above the menu\n  .border-top-radius(0);\n}\n","normalize.less":"/*! normalize.css v3.0.0 | MIT License | git.io/normalize */\n\n//\n// 1. Set default font family to sans-serif.\n// 2. Prevent iOS text size adjust after orientation change, without disabling\n//    user zoom.\n//\n\nhtml {\n  font-family: sans-serif; // 1\n  -ms-text-size-adjust: 100%; // 2\n  -webkit-text-size-adjust: 100%; // 2\n}\n\n//\n// Remove default margin.\n//\n\nbody {\n  margin: 0;\n}\n\n// HTML5 display definitions\n// ==========================================================================\n\n//\n// Correct `block` display not defined in IE 8/9.\n//\n\narticle,\naside,\ndetails,\nfigcaption,\nfigure,\nfooter,\nheader,\nhgroup,\nmain,\nnav,\nsection,\nsummary {\n  display: block;\n}\n\n//\n// 1. Correct `inline-block` display not defined in IE 8/9.\n// 2. Normalize vertical alignment of `progress` in Chrome, Firefox, and Opera.\n//\n\naudio,\ncanvas,\nprogress,\nvideo {\n  display: inline-block; // 1\n  vertical-align: baseline; // 2\n}\n\n//\n// Prevent modern browsers from displaying `audio` without controls.\n// Remove excess height in iOS 5 devices.\n//\n\naudio:not([controls]) {\n  display: none;\n  height: 0;\n}\n\n//\n// Address `[hidden]` styling not present in IE 8/9.\n// Hide the `template` element in IE, Safari, and Firefox < 22.\n//\n\n[hidden],\ntemplate {\n  display: none;\n}\n\n// Links\n// ==========================================================================\n\n//\n// Remove the gray background color from active links in IE 10.\n//\n\na {\n  background: transparent;\n}\n\n//\n// Improve readability when focused and also mouse hovered in all browsers.\n//\n\na:active,\na:hover {\n  outline: 0;\n}\n\n// Text-level semantics\n// ==========================================================================\n\n//\n// Address styling not present in IE 8/9, Safari 5, and Chrome.\n//\n\nabbr[title] {\n  border-bottom: 1px dotted;\n}\n\n//\n// Address style set to `bolder` in Firefox 4+, Safari 5, and Chrome.\n//\n\nb,\nstrong {\n  font-weight: bold;\n}\n\n//\n// Address styling not present in Safari 5 and Chrome.\n//\n\ndfn {\n  font-style: italic;\n}\n\n//\n// Address variable `h1` font-size and margin within `section` and `article`\n// contexts in Firefox 4+, Safari 5, and Chrome.\n//\n\nh1 {\n  font-size: 2em;\n  margin: 0.67em 0;\n}\n\n//\n// Address styling not present in IE 8/9.\n//\n\nmark {\n  background: #ff0;\n  color: #000;\n}\n\n//\n// Address inconsistent and variable font size in all browsers.\n//\n\nsmall {\n  font-size: 80%;\n}\n\n//\n// Prevent `sub` and `sup` affecting `line-height` in all browsers.\n//\n\nsub,\nsup {\n  font-size: 75%;\n  line-height: 0;\n  position: relative;\n  vertical-align: baseline;\n}\n\nsup {\n  top: -0.5em;\n}\n\nsub {\n  bottom: -0.25em;\n}\n\n// Embedded content\n// ==========================================================================\n\n//\n// Remove border when inside `a` element in IE 8/9.\n//\n\nimg {\n  border: 0;\n}\n\n//\n// Correct overflow displayed oddly in IE 9.\n//\n\nsvg:not(:root) {\n  overflow: hidden;\n}\n\n// Grouping content\n// ==========================================================================\n\n//\n// Address margin not present in IE 8/9 and Safari 5.\n//\n\nfigure {\n  margin: 1em 40px;\n}\n\n//\n// Address differences between Firefox and other browsers.\n//\n\nhr {\n  -moz-box-sizing: content-box;\n  box-sizing: content-box;\n  height: 0;\n}\n\n//\n// Contain overflow in all browsers.\n//\n\npre {\n  overflow: auto;\n}\n\n//\n// Address odd `em`-unit font size rendering in all browsers.\n//\n\ncode,\nkbd,\npre,\nsamp {\n  font-family: monospace, monospace;\n  font-size: 1em;\n}\n\n// Forms\n// ==========================================================================\n\n//\n// Known limitation: by default, Chrome and Safari on OS X allow very limited\n// styling of `select`, unless a `border` property is set.\n//\n\n//\n// 1. Correct color not being inherited.\n//    Known issue: affects color of disabled elements.\n// 2. Correct font properties not being inherited.\n// 3. Address margins set differently in Firefox 4+, Safari 5, and Chrome.\n//\n\nbutton,\ninput,\noptgroup,\nselect,\ntextarea {\n  color: inherit; // 1\n  font: inherit; // 2\n  margin: 0; // 3\n}\n\n//\n// Address `overflow` set to `hidden` in IE 8/9/10.\n//\n\nbutton {\n  overflow: visible;\n}\n\n//\n// Address inconsistent `text-transform` inheritance for `button` and `select`.\n// All other form control elements do not inherit `text-transform` values.\n// Correct `button` style inheritance in Firefox, IE 8+, and Opera\n// Correct `select` style inheritance in Firefox.\n//\n\nbutton,\nselect {\n  text-transform: none;\n}\n\n//\n// 1. Avoid the WebKit bug in Android 4.0.* where (2) destroys native `audio`\n//    and `video` controls.\n// 2. Correct inability to style clickable `input` types in iOS.\n// 3. Improve usability and consistency of cursor style between image-type\n//    `input` and others.\n//\n\nbutton,\nhtml input[type=\"button\"], // 1\ninput[type=\"reset\"],\ninput[type=\"submit\"] {\n  -webkit-appearance: button; // 2\n  cursor: pointer; // 3\n}\n\n//\n// Re-set default cursor for disabled elements.\n//\n\nbutton[disabled],\nhtml input[disabled] {\n  cursor: default;\n}\n\n//\n// Remove inner padding and border in Firefox 4+.\n//\n\nbutton::-moz-focus-inner,\ninput::-moz-focus-inner {\n  border: 0;\n  padding: 0;\n}\n\n//\n// Address Firefox 4+ setting `line-height` on `input` using `!important` in\n// the UA stylesheet.\n//\n\ninput {\n  line-height: normal;\n}\n\n//\n// It's recommended that you don't attempt to style these elements.\n// Firefox's implementation doesn't respect box-sizing, padding, or width.\n//\n// 1. Address box sizing set to `content-box` in IE 8/9/10.\n// 2. Remove excess padding in IE 8/9/10.\n//\n\ninput[type=\"checkbox\"],\ninput[type=\"radio\"] {\n  box-sizing: border-box; // 1\n  padding: 0; // 2\n}\n\n//\n// Fix the cursor style for Chrome's increment/decrement buttons. For certain\n// `font-size` values of the `input`, it causes the cursor style of the\n// decrement button to change from `default` to `text`.\n//\n\ninput[type=\"number\"]::-webkit-inner-spin-button,\ninput[type=\"number\"]::-webkit-outer-spin-button {\n  height: auto;\n}\n\n//\n// 1. Address `appearance` set to `searchfield` in Safari 5 and Chrome.\n// 2. Address `box-sizing` set to `border-box` in Safari 5 and Chrome\n//    (include `-moz` to future-proof).\n//\n\ninput[type=\"search\"] {\n  -webkit-appearance: textfield; // 1\n  -moz-box-sizing: content-box;\n  -webkit-box-sizing: content-box; // 2\n  box-sizing: content-box;\n}\n\n//\n// Remove inner padding and search cancel button in Safari and Chrome on OS X.\n// Safari (but not Chrome) clips the cancel button when the search input has\n// padding (and `textfield` appearance).\n//\n\ninput[type=\"search\"]::-webkit-search-cancel-button,\ninput[type=\"search\"]::-webkit-search-decoration {\n  -webkit-appearance: none;\n}\n\n//\n// Define consistent border, margin, and padding.\n//\n\nfieldset {\n  border: 1px solid #c0c0c0;\n  margin: 0 2px;\n  padding: 0.35em 0.625em 0.75em;\n}\n\n//\n// 1. Correct `color` not being inherited in IE 8/9.\n// 2. Remove padding so people aren't caught out if they zero out fieldsets.\n//\n\nlegend {\n  border: 0; // 1\n  padding: 0; // 2\n}\n\n//\n// Remove default vertical scrollbar in IE 8/9.\n//\n\ntextarea {\n  overflow: auto;\n}\n\n//\n// Don't inherit the `font-weight` (applied by a rule above).\n// NOTE: the default cannot safely be changed in Chrome and Safari on OS X.\n//\n\noptgroup {\n  font-weight: bold;\n}\n\n// Tables\n// ==========================================================================\n\n//\n// Remove most spacing between table cells.\n//\n\ntable {\n  border-collapse: collapse;\n  border-spacing: 0;\n}\n\ntd,\nth {\n  padding: 0;\n}","pager.less":"//\n// Pager pagination\n// --------------------------------------------------\n\n\n.pager {\n  padding-left: 0;\n  margin: @line-height-computed 0;\n  list-style: none;\n  text-align: center;\n  &:extend(.clearfix all);\n  li {\n    display: inline;\n    > a,\n    > span {\n      display: inline-block;\n      padding: 5px 14px;\n      background-color: @pager-bg;\n      border: 1px solid @pager-border;\n      border-radius: @pager-border-radius;\n    }\n\n    > a:hover,\n    > a:focus {\n      text-decoration: none;\n      background-color: @pager-hover-bg;\n    }\n  }\n\n  .next {\n    > a,\n    > span {\n      float: right;\n    }\n  }\n\n  .previous {\n    > a,\n    > span {\n      float: left;\n    }\n  }\n\n  .disabled {\n    > a,\n    > a:hover,\n    > a:focus,\n    > span {\n      color: @pager-disabled-color;\n      background-color: @pager-bg;\n      cursor: not-allowed;\n    }\n  }\n\n}\n","pagination.less":"//\n// Pagination (multiple pages)\n// --------------------------------------------------\n.pagination {\n  display: inline-block;\n  padding-left: 0;\n  margin: @line-height-computed 0;\n  border-radius: @border-radius-base;\n\n  > li {\n    display: inline; // Remove list-style and block-level defaults\n    > a,\n    > span {\n      position: relative;\n      float: left; // Collapse white-space\n      padding: @padding-base-vertical @padding-base-horizontal;\n      line-height: @line-height-base;\n      text-decoration: none;\n      color: @pagination-color;\n      background-color: @pagination-bg;\n      border: 1px solid @pagination-border;\n      margin-left: -1px;\n    }\n    &:first-child {\n      > a,\n      > span {\n        margin-left: 0;\n        .border-left-radius(@border-radius-base);\n      }\n    }\n    &:last-child {\n      > a,\n      > span {\n        .border-right-radius(@border-radius-base);\n      }\n    }\n  }\n\n  > li > a,\n  > li > span {\n    &:hover,\n    &:focus {\n      color: @pagination-hover-color;\n      background-color: @pagination-hover-bg;\n      border-color: @pagination-hover-border;\n    }\n  }\n\n  > .active > a,\n  > .active > span {\n    &,\n    &:hover,\n    &:focus {\n      z-index: 2;\n      color: @pagination-active-color;\n      background-color: @pagination-active-bg;\n      border-color: @pagination-active-border;\n      cursor: default;\n    }\n  }\n\n  > .disabled {\n    > span,\n    > span:hover,\n    > span:focus,\n    > a,\n    > a:hover,\n    > a:focus {\n      color: @pagination-disabled-color;\n      background-color: @pagination-disabled-bg;\n      border-color: @pagination-disabled-border;\n      cursor: not-allowed;\n    }\n  }\n}\n\n// Sizing\n// --------------------------------------------------\n\n// Large\n.pagination-lg {\n  .pagination-size(@padding-large-vertical; @padding-large-horizontal; @font-size-large; @border-radius-large);\n}\n\n// Small\n.pagination-sm {\n  .pagination-size(@padding-small-vertical; @padding-small-horizontal; @font-size-small; @border-radius-small);\n}\n","panels.less":"//\n// Panels\n// --------------------------------------------------\n\n\n// Base class\n.panel {\n  margin-bottom: @line-height-computed;\n  background-color: @panel-bg;\n  border: 1px solid transparent;\n  border-radius: @panel-border-radius;\n  .box-shadow(0 1px 1px rgba(0,0,0,.05));\n}\n\n// Panel contents\n.panel-body {\n  padding: @panel-body-padding;\n  &:extend(.clearfix all);\n}\n\n// Optional heading\n.panel-heading {\n  padding: 10px 15px;\n  border-bottom: 1px solid transparent;\n  .border-top-radius((@panel-border-radius - 1));\n\n  > .dropdown .dropdown-toggle {\n    color: inherit;\n  }\n}\n\n// Within heading, strip any `h*` tag of its default margins for spacing.\n.panel-title {\n  margin-top: 0;\n  margin-bottom: 0;\n  font-size: ceil((@font-size-base * 1.125));\n  color: inherit;\n\n  > a {\n    color: inherit;\n  }\n}\n\n// Optional footer (stays gray in every modifier class)\n.panel-footer {\n  padding: 10px 15px;\n  background-color: @panel-footer-bg;\n  border-top: 1px solid @panel-inner-border;\n  .border-bottom-radius((@panel-border-radius - 1));\n}\n\n\n// List groups in panels\n//\n// By default, space out list group content from panel headings to account for\n// any kind of custom content between the two.\n\n.panel {\n  > .list-group {\n    margin-bottom: 0;\n\n    .list-group-item {\n      border-width: 1px 0;\n      border-radius: 0;\n    }\n\n    // Add border top radius for first one\n    &:first-child {\n      .list-group-item:first-child {\n        border-top: 0;\n        .border-top-radius((@panel-border-radius - 1));\n      }\n    }\n    // Add border bottom radius for last one\n    &:last-child {\n      .list-group-item:last-child {\n        border-bottom: 0;\n        .border-bottom-radius((@panel-border-radius - 1));\n      }\n    }\n  }\n}\n// Collapse space between when there's no additional content.\n.panel-heading + .list-group {\n  .list-group-item:first-child {\n    border-top-width: 0;\n  }\n}\n\n\n// Tables in panels\n//\n// Place a non-bordered `.table` within a panel (not within a `.panel-body`) and\n// watch it go full width.\n\n.panel {\n  > .table,\n  > .table-responsive > .table {\n    margin-bottom: 0;\n  }\n  // Add border top radius for first one\n  > .table:first-child,\n  > .table-responsive:first-child > .table:first-child {\n    .border-top-radius((@panel-border-radius - 1));\n\n    > thead:first-child,\n    > tbody:first-child {\n      > tr:first-child {\n        td:first-child,\n        th:first-child {\n          border-top-left-radius: (@panel-border-radius - 1);\n        }\n        td:last-child,\n        th:last-child {\n          border-top-right-radius: (@panel-border-radius - 1);\n        }\n      }\n    }\n  }\n  // Add border bottom radius for last one\n  > .table:last-child,\n  > .table-responsive:last-child > .table:last-child {\n    .border-bottom-radius((@panel-border-radius - 1));\n\n    > tbody:last-child,\n    > tfoot:last-child {\n      > tr:last-child {\n        td:first-child,\n        th:first-child {\n          border-bottom-left-radius: (@panel-border-radius - 1);\n        }\n        td:last-child,\n        th:last-child {\n          border-bottom-right-radius: (@panel-border-radius - 1);\n        }\n      }\n    }\n  }\n  > .panel-body + .table,\n  > .panel-body + .table-responsive {\n    border-top: 1px solid @table-border-color;\n  }\n  > .table > tbody:first-child > tr:first-child th,\n  > .table > tbody:first-child > tr:first-child td {\n    border-top: 0;\n  }\n  > .table-bordered,\n  > .table-responsive > .table-bordered {\n    border: 0;\n    > thead,\n    > tbody,\n    > tfoot {\n      > tr {\n        > th:first-child,\n        > td:first-child {\n          border-left: 0;\n        }\n        > th:last-child,\n        > td:last-child {\n          border-right: 0;\n        }\n      }\n    }\n    > thead,\n    > tbody {\n      > tr:first-child {\n        > td,\n        > th {\n          border-bottom: 0;\n        }\n      }\n    }\n    > tbody,\n    > tfoot {\n      > tr:last-child {\n        > td,\n        > th {\n          border-bottom: 0;\n        }\n      }\n    }\n  }\n  > .table-responsive {\n    border: 0;\n    margin-bottom: 0;\n  }\n}\n\n\n// Collapsable panels (aka, accordion)\n//\n// Wrap a series of panels in `.panel-group` to turn them into an accordion with\n// the help of our collapse JavaScript plugin.\n\n.panel-group {\n  margin-bottom: @line-height-computed;\n\n  // Tighten up margin so it's only between panels\n  .panel {\n    margin-bottom: 0;\n    border-radius: @panel-border-radius;\n    overflow: hidden; // crop contents when collapsed\n    + .panel {\n      margin-top: 5px;\n    }\n  }\n\n  .panel-heading {\n    border-bottom: 0;\n    + .panel-collapse .panel-body {\n      border-top: 1px solid @panel-inner-border;\n    }\n  }\n  .panel-footer {\n    border-top: 0;\n    + .panel-collapse .panel-body {\n      border-bottom: 1px solid @panel-inner-border;\n    }\n  }\n}\n\n\n// Contextual variations\n.panel-default {\n  .panel-variant(@panel-default-border; @panel-default-text; @panel-default-heading-bg; @panel-default-border);\n}\n.panel-primary {\n  .panel-variant(@panel-primary-border; @panel-primary-text; @panel-primary-heading-bg; @panel-primary-border);\n}\n.panel-success {\n  .panel-variant(@panel-success-border; @panel-success-text; @panel-success-heading-bg; @panel-success-border);\n}\n.panel-info {\n  .panel-variant(@panel-info-border; @panel-info-text; @panel-info-heading-bg; @panel-info-border);\n}\n.panel-warning {\n  .panel-variant(@panel-warning-border; @panel-warning-text; @panel-warning-heading-bg; @panel-warning-border);\n}\n.panel-danger {\n  .panel-variant(@panel-danger-border; @panel-danger-text; @panel-danger-heading-bg; @panel-danger-border);\n}\n","popovers.less":"//\n// Popovers\n// --------------------------------------------------\n\n\n.popover {\n  position: absolute;\n  top: 0;\n  left: 0;\n  z-index: @zindex-popover;\n  display: none;\n  max-width: @popover-max-width;\n  padding: 1px;\n  text-align: left; // Reset given new insertion method\n  background-color: @popover-bg;\n  background-clip: padding-box;\n  border: 1px solid @popover-fallback-border-color;\n  border: 1px solid @popover-border-color;\n  border-radius: @border-radius-large;\n  .box-shadow(0 5px 10px rgba(0,0,0,.2));\n\n  // Overrides for proper insertion\n  white-space: normal;\n\n  // Offset the popover to account for the popover arrow\n  &.top     { margin-top: -@popover-arrow-width; }\n  &.right   { margin-left: @popover-arrow-width; }\n  &.bottom  { margin-top: @popover-arrow-width; }\n  &.left    { margin-left: -@popover-arrow-width; }\n}\n\n.popover-title {\n  margin: 0; // reset heading margin\n  padding: 8px 14px;\n  font-size: @font-size-base;\n  font-weight: normal;\n  line-height: 18px;\n  background-color: @popover-title-bg;\n  border-bottom: 1px solid darken(@popover-title-bg, 5%);\n  border-radius: 5px 5px 0 0;\n}\n\n.popover-content {\n  padding: 9px 14px;\n}\n\n// Arrows\n//\n// .arrow is outer, .arrow:after is inner\n\n.popover > .arrow {\n  &,\n  &:after {\n    position: absolute;\n    display: block;\n    width: 0;\n    height: 0;\n    border-color: transparent;\n    border-style: solid;\n  }\n}\n.popover > .arrow {\n  border-width: @popover-arrow-outer-width;\n}\n.popover > .arrow:after {\n  border-width: @popover-arrow-width;\n  content: \"\";\n}\n\n.popover {\n  &.top > .arrow {\n    left: 50%;\n    margin-left: -@popover-arrow-outer-width;\n    border-bottom-width: 0;\n    border-top-color: @popover-arrow-outer-fallback-color; // IE8 fallback\n    border-top-color: @popover-arrow-outer-color;\n    bottom: -@popover-arrow-outer-width;\n    &:after {\n      content: \" \";\n      bottom: 1px;\n      margin-left: -@popover-arrow-width;\n      border-bottom-width: 0;\n      border-top-color: @popover-arrow-color;\n    }\n  }\n  &.right > .arrow {\n    top: 50%;\n    left: -@popover-arrow-outer-width;\n    margin-top: -@popover-arrow-outer-width;\n    border-left-width: 0;\n    border-right-color: @popover-arrow-outer-fallback-color; // IE8 fallback\n    border-right-color: @popover-arrow-outer-color;\n    &:after {\n      content: \" \";\n      left: 1px;\n      bottom: -@popover-arrow-width;\n      border-left-width: 0;\n      border-right-color: @popover-arrow-color;\n    }\n  }\n  &.bottom > .arrow {\n    left: 50%;\n    margin-left: -@popover-arrow-outer-width;\n    border-top-width: 0;\n    border-bottom-color: @popover-arrow-outer-fallback-color; // IE8 fallback\n    border-bottom-color: @popover-arrow-outer-color;\n    top: -@popover-arrow-outer-width;\n    &:after {\n      content: \" \";\n      top: 1px;\n      margin-left: -@popover-arrow-width;\n      border-top-width: 0;\n      border-bottom-color: @popover-arrow-color;\n    }\n  }\n\n  &.left > .arrow {\n    top: 50%;\n    right: -@popover-arrow-outer-width;\n    margin-top: -@popover-arrow-outer-width;\n    border-right-width: 0;\n    border-left-color: @popover-arrow-outer-fallback-color; // IE8 fallback\n    border-left-color: @popover-arrow-outer-color;\n    &:after {\n      content: \" \";\n      right: 1px;\n      border-right-width: 0;\n      border-left-color: @popover-arrow-color;\n      bottom: -@popover-arrow-width;\n    }\n  }\n\n}\n","print.less":"//\n// Basic print styles\n// --------------------------------------------------\n// Source: https://github.com/h5bp/html5-boilerplate/blob/master/css/main.css\n\n@media print {\n\n  * {\n    text-shadow: none !important;\n    color: #000 !important; // Black prints faster: h5bp.com/s\n    background: transparent !important;\n    box-shadow: none !important;\n  }\n\n  a,\n  a:visited {\n    text-decoration: underline;\n  }\n\n  a[href]:after {\n    content: \" (\" attr(href) \")\";\n  }\n\n  abbr[title]:after {\n    content: \" (\" attr(title) \")\";\n  }\n\n  // Don't show links for images, or javascript/internal links\n  a[href^=\"javascript:\"]:after,\n  a[href^=\"#\"]:after {\n    content: \"\";\n  }\n\n  pre,\n  blockquote {\n    border: 1px solid #999;\n    page-break-inside: avoid;\n  }\n\n  thead {\n    display: table-header-group; // h5bp.com/t\n  }\n\n  tr,\n  img {\n    page-break-inside: avoid;\n  }\n\n  img {\n    max-width: 100% !important;\n  }\n\n  p,\n  h2,\n  h3 {\n    orphans: 3;\n    widows: 3;\n  }\n\n  h2,\n  h3 {\n    page-break-after: avoid;\n  }\n\n  // Chrome (OSX) fix for https://github.com/twbs/bootstrap/issues/11245\n  // Once fixed, we can just straight up remove this.\n  select {\n    background: #fff !important;\n  }\n\n  // Bootstrap components\n  .navbar {\n    display: none;\n  }\n  .table {\n    td,\n    th {\n      background-color: #fff !important;\n    }\n  }\n  .btn,\n  .dropup > .btn {\n    > .caret {\n      border-top-color: #000 !important;\n    }\n  }\n  .label {\n    border: 1px solid #000;\n  }\n\n  .table {\n    border-collapse: collapse !important;\n  }\n  .table-bordered {\n    th,\n    td {\n      border: 1px solid #ddd !important;\n    }\n  }\n\n}\n","progress-bars.less":"//\n// Progress bars\n// --------------------------------------------------\n\n\n// Bar animations\n// -------------------------\n\n// WebKit\n@-webkit-keyframes progress-bar-stripes {\n  from  { background-position: 40px 0; }\n  to    { background-position: 0 0; }\n}\n\n// Spec and IE10+\n@keyframes progress-bar-stripes {\n  from  { background-position: 40px 0; }\n  to    { background-position: 0 0; }\n}\n\n\n\n// Bar itself\n// -------------------------\n\n// Outer container\n.progress {\n  overflow: hidden;\n  height: @line-height-computed;\n  margin-bottom: @line-height-computed;\n  background-color: @progress-bg;\n  border-radius: @border-radius-base;\n  .box-shadow(inset 0 1px 2px rgba(0,0,0,.1));\n}\n\n// Bar of progress\n.progress-bar {\n  float: left;\n  width: 0%;\n  height: 100%;\n  font-size: @font-size-small;\n  line-height: @line-height-computed;\n  color: @progress-bar-color;\n  text-align: center;\n  background-color: @progress-bar-bg;\n  .box-shadow(inset 0 -1px 0 rgba(0,0,0,.15));\n  .transition(width .6s ease);\n}\n\n// Striped bars\n.progress-striped .progress-bar {\n  #gradient > .striped();\n  background-size: 40px 40px;\n}\n\n// Call animation for the active one\n.progress.active .progress-bar {\n  .animation(progress-bar-stripes 2s linear infinite);\n}\n\n\n\n// Variations\n// -------------------------\n\n.progress-bar-success {\n  .progress-bar-variant(@progress-bar-success-bg);\n}\n\n.progress-bar-info {\n  .progress-bar-variant(@progress-bar-info-bg);\n}\n\n.progress-bar-warning {\n  .progress-bar-variant(@progress-bar-warning-bg);\n}\n\n.progress-bar-danger {\n  .progress-bar-variant(@progress-bar-danger-bg);\n}\n","responsive-utilities.less":"//\n// Responsive: Utility classes\n// --------------------------------------------------\n\n\n// IE10 in Windows (Phone) 8\n//\n// Support for responsive views via media queries is kind of borked in IE10, for\n// Surface/desktop in split view and for Windows Phone 8. This particular fix\n// must be accompanied by a snippet of JavaScript to sniff the user agent and\n// apply some conditional CSS to *only* the Surface/desktop Windows 8. Look at\n// our Getting Started page for more information on this bug.\n//\n// For more information, see the following:\n//\n// Issue: https://github.com/twbs/bootstrap/issues/10497\n// Docs: http://getbootstrap.com/getting-started/#browsers\n// Source: http://timkadlec.com/2012/10/ie10-snap-mode-and-responsive-design/\n\n@-ms-viewport {\n  width: device-width;\n}\n\n\n// Visibility utilities\n.visible-xs,\n.visible-sm,\n.visible-md,\n.visible-lg {\n  .responsive-invisibility();\n}\n\n.visible-xs {\n  @media (max-width: @screen-xs-max) {\n    .responsive-visibility();\n  }\n}\n.visible-sm {\n  @media (min-width: @screen-sm-min) and (max-width: @screen-sm-max) {\n    .responsive-visibility();\n  }\n}\n.visible-md {\n  @media (min-width: @screen-md-min) and (max-width: @screen-md-max) {\n    .responsive-visibility();\n  }\n}\n.visible-lg {\n  @media (min-width: @screen-lg-min) {\n    .responsive-visibility();\n  }\n}\n\n.hidden-xs {\n  @media (max-width: @screen-xs-max) {\n    .responsive-invisibility();\n  }\n}\n.hidden-sm {\n  @media (min-width: @screen-sm-min) and (max-width: @screen-sm-max) {\n    .responsive-invisibility();\n  }\n}\n.hidden-md {\n  @media (min-width: @screen-md-min) and (max-width: @screen-md-max) {\n    .responsive-invisibility();\n  }\n}\n.hidden-lg {\n  @media (min-width: @screen-lg-min) {\n    .responsive-invisibility();\n  }\n}\n\n\n// Print utilities\n//\n// Media queries are placed on the inside to be mixin-friendly.\n\n.visible-print {\n  .responsive-invisibility();\n\n  @media print {\n    .responsive-visibility();\n  }\n}\n\n.hidden-print {\n  @media print {\n    .responsive-invisibility();\n  }\n}\n","scaffolding.less":"//\n// Scaffolding\n// --------------------------------------------------\n\n\n// Reset the box-sizing\n//\n// Heads up! This reset may cause conflicts with some third-party widgets.\n// For recommendations on resolving such conflicts, see\n// http://getbootstrap.com/getting-started/#third-box-sizing\n* {\n  .box-sizing(border-box);\n}\n*:before,\n*:after {\n  .box-sizing(border-box);\n}\n\n\n// Body reset\n\nhtml {\n  font-size: 62.5%;\n  -webkit-tap-highlight-color: rgba(0,0,0,0);\n}\n\nbody {\n  font-family: @font-family-base;\n  font-size: @font-size-base;\n  line-height: @line-height-base;\n  color: @text-color;\n  background-color: @body-bg;\n}\n\n// Reset fonts for relevant elements\ninput,\nbutton,\nselect,\ntextarea {\n  font-family: inherit;\n  font-size: inherit;\n  line-height: inherit;\n}\n\n\n// Links\n\na {\n  color: @link-color;\n  text-decoration: none;\n\n  &:hover,\n  &:focus {\n    color: @link-hover-color;\n    text-decoration: underline;\n  }\n\n  &:focus {\n    .tab-focus();\n  }\n}\n\n\n// Figures\n//\n// We reset this here because previously Normalize had no `figure` margins. This\n// ensures we don't break anyone's use of the element.\n\nfigure {\n  margin: 0;\n}\n\n\n// Images\n\nimg {\n  vertical-align: middle;\n}\n\n// Responsive images (ensure images don't scale beyond their parents)\n.img-responsive {\n  .img-responsive();\n}\n\n// Rounded corners\n.img-rounded {\n  border-radius: @border-radius-large;\n}\n\n// Image thumbnails\n//\n// Heads up! This is mixin-ed into thumbnails.less for `.thumbnail`.\n.img-thumbnail {\n  padding: @thumbnail-padding;\n  line-height: @line-height-base;\n  background-color: @thumbnail-bg;\n  border: 1px solid @thumbnail-border;\n  border-radius: @thumbnail-border-radius;\n  .transition(all .2s ease-in-out);\n\n  // Keep them at most 100% wide\n  .img-responsive(inline-block);\n}\n\n// Perfect circle\n.img-circle {\n  border-radius: 50%; // set radius in percents\n}\n\n\n// Horizontal rules\n\nhr {\n  margin-top:    @line-height-computed;\n  margin-bottom: @line-height-computed;\n  border: 0;\n  border-top: 1px solid @hr-border;\n}\n\n\n// Only display content to screen readers\n//\n// See: http://a11yproject.com/posts/how-to-hide-content/\n\n.sr-only {\n  position: absolute;\n  width: 1px;\n  height: 1px;\n  margin: -1px;\n  padding: 0;\n  overflow: hidden;\n  clip: rect(0,0,0,0);\n  border: 0;\n}\n","tables.less":"//\n// Tables\n// --------------------------------------------------\n\n\ntable {\n  max-width: 100%;\n  background-color: @table-bg;\n}\nth {\n  text-align: left;\n}\n\n\n// Baseline styles\n\n.table {\n  width: 100%;\n  margin-bottom: @line-height-computed;\n  // Cells\n  > thead,\n  > tbody,\n  > tfoot {\n    > tr {\n      > th,\n      > td {\n        padding: @table-cell-padding;\n        line-height: @line-height-base;\n        vertical-align: top;\n        border-top: 1px solid @table-border-color;\n      }\n    }\n  }\n  // Bottom align for column headings\n  > thead > tr > th {\n    vertical-align: bottom;\n    border-bottom: 2px solid @table-border-color;\n  }\n  // Remove top border from thead by default\n  > caption + thead,\n  > colgroup + thead,\n  > thead:first-child {\n    > tr:first-child {\n      > th,\n      > td {\n        border-top: 0;\n      }\n    }\n  }\n  // Account for multiple tbody instances\n  > tbody + tbody {\n    border-top: 2px solid @table-border-color;\n  }\n\n  // Nesting\n  .table {\n    background-color: @body-bg;\n  }\n}\n\n\n// Condensed table w/ half padding\n\n.table-condensed {\n  > thead,\n  > tbody,\n  > tfoot {\n    > tr {\n      > th,\n      > td {\n        padding: @table-condensed-cell-padding;\n      }\n    }\n  }\n}\n\n\n// Bordered version\n//\n// Add borders all around the table and between all the columns.\n\n.table-bordered {\n  border: 1px solid @table-border-color;\n  > thead,\n  > tbody,\n  > tfoot {\n    > tr {\n      > th,\n      > td {\n        border: 1px solid @table-border-color;\n      }\n    }\n  }\n  > thead > tr {\n    > th,\n    > td {\n      border-bottom-width: 2px;\n    }\n  }\n}\n\n\n// Zebra-striping\n//\n// Default zebra-stripe styles (alternating gray and transparent backgrounds)\n\n.table-striped {\n  > tbody > tr:nth-child(odd) {\n    > td,\n    > th {\n      background-color: @table-bg-accent;\n    }\n  }\n}\n\n\n// Hover effect\n//\n// Placed here since it has to come after the potential zebra striping\n\n.table-hover {\n  > tbody > tr:hover {\n    > td,\n    > th {\n      background-color: @table-bg-hover;\n    }\n  }\n}\n\n\n// Table cell sizing\n//\n// Reset default table behavior\n\ntable col[class*=\"col-\"] {\n  position: static; // Prevent border hiding in Firefox and IE9/10 (see https://github.com/twbs/bootstrap/issues/11623)\n  float: none;\n  display: table-column;\n}\ntable {\n  td,\n  th {\n    &[class*=\"col-\"] {\n      position: static; // Prevent border hiding in Firefox and IE9/10 (see https://github.com/twbs/bootstrap/issues/11623)\n      float: none;\n      display: table-cell;\n    }\n  }\n}\n\n\n// Table backgrounds\n//\n// Exact selectors below required to override `.table-striped` and prevent\n// inheritance to nested tables.\n\n// Generate the contextual variants\n.table-row-variant(active; @table-bg-active);\n.table-row-variant(success; @state-success-bg);\n.table-row-variant(info; @state-info-bg);\n.table-row-variant(warning; @state-warning-bg);\n.table-row-variant(danger; @state-danger-bg);\n\n\n// Responsive tables\n//\n// Wrap your tables in `.table-responsive` and we'll make them mobile friendly\n// by enabling horizontal scrolling. Only applies <768px. Everything above that\n// will display normally.\n\n@media (max-width: @screen-xs-max) {\n  .table-responsive {\n    width: 100%;\n    margin-bottom: (@line-height-computed * 0.75);\n    overflow-y: hidden;\n    overflow-x: scroll;\n    -ms-overflow-style: -ms-autohiding-scrollbar;\n    border: 1px solid @table-border-color;\n    -webkit-overflow-scrolling: touch;\n\n    // Tighten up spacing\n    > .table {\n      margin-bottom: 0;\n\n      // Ensure the content doesn't wrap\n      > thead,\n      > tbody,\n      > tfoot {\n        > tr {\n          > th,\n          > td {\n            white-space: nowrap;\n          }\n        }\n      }\n    }\n\n    // Special overrides for the bordered tables\n    > .table-bordered {\n      border: 0;\n\n      // Nuke the appropriate borders so that the parent can handle them\n      > thead,\n      > tbody,\n      > tfoot {\n        > tr {\n          > th:first-child,\n          > td:first-child {\n            border-left: 0;\n          }\n          > th:last-child,\n          > td:last-child {\n            border-right: 0;\n          }\n        }\n      }\n\n      // Only nuke the last row's bottom-border in `tbody` and `tfoot` since\n      // chances are there will be only one `tr` in a `thead` and that would\n      // remove the border altogether.\n      > tbody,\n      > tfoot {\n        > tr:last-child {\n          > th,\n          > td {\n            border-bottom: 0;\n          }\n        }\n      }\n\n    }\n  }\n}\n","theme.less":"\n//\n// Load core variables and mixins\n// --------------------------------------------------\n\n@import \"variables.less\";\n@import \"mixins.less\";\n\n\n\n//\n// Buttons\n// --------------------------------------------------\n\n// Common styles\n.btn-default,\n.btn-primary,\n.btn-success,\n.btn-info,\n.btn-warning,\n.btn-danger {\n  text-shadow: 0 -1px 0 rgba(0,0,0,.2);\n  @shadow: inset 0 1px 0 rgba(255,255,255,.15), 0 1px 1px rgba(0,0,0,.075);\n  .box-shadow(@shadow);\n\n  // Reset the shadow\n  &:active,\n  &.active {\n    .box-shadow(inset 0 3px 5px rgba(0,0,0,.125));\n  }\n}\n\n// Mixin for generating new styles\n.btn-styles(@btn-color: #555) {\n  #gradient > .vertical(@start-color: @btn-color; @end-color: darken(@btn-color, 12%));\n  .reset-filter(); // Disable gradients for IE9 because filter bleeds through rounded corners\n  background-repeat: repeat-x;\n  border-color: darken(@btn-color, 14%);\n\n  &:hover,\n  &:focus  {\n    background-color: darken(@btn-color, 12%);\n    background-position: 0 -15px;\n  }\n\n  &:active,\n  &.active {\n    background-color: darken(@btn-color, 12%);\n    border-color: darken(@btn-color, 14%);\n  }\n}\n\n// Common styles\n.btn {\n  // Remove the gradient for the pressed/active state\n  &:active,\n  &.active {\n    background-image: none;\n  }\n}\n\n// Apply the mixin to the buttons\n.btn-default { .btn-styles(@btn-default-bg); text-shadow: 0 1px 0 #fff; border-color: #ccc; }\n.btn-primary { .btn-styles(@btn-primary-bg); }\n.btn-success { .btn-styles(@btn-success-bg); }\n.btn-info    { .btn-styles(@btn-info-bg); }\n.btn-warning { .btn-styles(@btn-warning-bg); }\n.btn-danger  { .btn-styles(@btn-danger-bg); }\n\n\n\n//\n// Images\n// --------------------------------------------------\n\n.thumbnail,\n.img-thumbnail {\n  .box-shadow(0 1px 2px rgba(0,0,0,.075));\n}\n\n\n\n//\n// Dropdowns\n// --------------------------------------------------\n\n.dropdown-menu > li > a:hover,\n.dropdown-menu > li > a:focus {\n  #gradient > .vertical(@start-color: @dropdown-link-hover-bg; @end-color: darken(@dropdown-link-hover-bg, 5%));\n  background-color: darken(@dropdown-link-hover-bg, 5%);\n}\n.dropdown-menu > .active > a,\n.dropdown-menu > .active > a:hover,\n.dropdown-menu > .active > a:focus {\n  #gradient > .vertical(@start-color: @dropdown-link-active-bg; @end-color: darken(@dropdown-link-active-bg, 5%));\n  background-color: darken(@dropdown-link-active-bg, 5%);\n}\n\n\n\n//\n// Navbar\n// --------------------------------------------------\n\n// Default navbar\n.navbar-default {\n  #gradient > .vertical(@start-color: lighten(@navbar-default-bg, 10%); @end-color: @navbar-default-bg);\n  .reset-filter(); // Remove gradient in IE<10 to fix bug where dropdowns don't get triggered\n  border-radius: @navbar-border-radius;\n  @shadow: inset 0 1px 0 rgba(255,255,255,.15), 0 1px 5px rgba(0,0,0,.075);\n  .box-shadow(@shadow);\n\n  .navbar-nav > .active > a {\n    #gradient > .vertical(@start-color: darken(@navbar-default-bg, 5%); @end-color: darken(@navbar-default-bg, 2%));\n    .box-shadow(inset 0 3px 9px rgba(0,0,0,.075));\n  }\n}\n.navbar-brand,\n.navbar-nav > li > a {\n  text-shadow: 0 1px 0 rgba(255,255,255,.25);\n}\n\n// Inverted navbar\n.navbar-inverse {\n  #gradient > .vertical(@start-color: lighten(@navbar-inverse-bg, 10%); @end-color: @navbar-inverse-bg);\n  .reset-filter(); // Remove gradient in IE<10 to fix bug where dropdowns don't get triggered\n\n  .navbar-nav > .active > a {\n    #gradient > .vertical(@start-color: @navbar-inverse-bg; @end-color: lighten(@navbar-inverse-bg, 2.5%));\n    .box-shadow(inset 0 3px 9px rgba(0,0,0,.25));\n  }\n\n  .navbar-brand,\n  .navbar-nav > li > a {\n    text-shadow: 0 -1px 0 rgba(0,0,0,.25);\n  }\n}\n\n// Undo rounded corners in static and fixed navbars\n.navbar-static-top,\n.navbar-fixed-top,\n.navbar-fixed-bottom {\n  border-radius: 0;\n}\n\n\n\n//\n// Alerts\n// --------------------------------------------------\n\n// Common styles\n.alert {\n  text-shadow: 0 1px 0 rgba(255,255,255,.2);\n  @shadow: inset 0 1px 0 rgba(255,255,255,.25), 0 1px 2px rgba(0,0,0,.05);\n  .box-shadow(@shadow);\n}\n\n// Mixin for generating new styles\n.alert-styles(@color) {\n  #gradient > .vertical(@start-color: @color; @end-color: darken(@color, 7.5%));\n  border-color: darken(@color, 15%);\n}\n\n// Apply the mixin to the alerts\n.alert-success    { .alert-styles(@alert-success-bg); }\n.alert-info       { .alert-styles(@alert-info-bg); }\n.alert-warning    { .alert-styles(@alert-warning-bg); }\n.alert-danger     { .alert-styles(@alert-danger-bg); }\n\n\n\n//\n// Progress bars\n// --------------------------------------------------\n\n// Give the progress background some depth\n.progress {\n  #gradient > .vertical(@start-color: darken(@progress-bg, 4%); @end-color: @progress-bg)\n}\n\n// Mixin for generating new styles\n.progress-bar-styles(@color) {\n  #gradient > .vertical(@start-color: @color; @end-color: darken(@color, 10%));\n}\n\n// Apply the mixin to the progress bars\n.progress-bar            { .progress-bar-styles(@progress-bar-bg); }\n.progress-bar-success    { .progress-bar-styles(@progress-bar-success-bg); }\n.progress-bar-info       { .progress-bar-styles(@progress-bar-info-bg); }\n.progress-bar-warning    { .progress-bar-styles(@progress-bar-warning-bg); }\n.progress-bar-danger     { .progress-bar-styles(@progress-bar-danger-bg); }\n\n\n\n//\n// List groups\n// --------------------------------------------------\n\n.list-group {\n  border-radius: @border-radius-base;\n  .box-shadow(0 1px 2px rgba(0,0,0,.075));\n}\n.list-group-item.active,\n.list-group-item.active:hover,\n.list-group-item.active:focus {\n  text-shadow: 0 -1px 0 darken(@list-group-active-bg, 10%);\n  #gradient > .vertical(@start-color: @list-group-active-bg; @end-color: darken(@list-group-active-bg, 7.5%));\n  border-color: darken(@list-group-active-border, 7.5%);\n}\n\n\n\n//\n// Panels\n// --------------------------------------------------\n\n// Common styles\n.panel {\n  .box-shadow(0 1px 2px rgba(0,0,0,.05));\n}\n\n// Mixin for generating new styles\n.panel-heading-styles(@color) {\n  #gradient > .vertical(@start-color: @color; @end-color: darken(@color, 5%));\n}\n\n// Apply the mixin to the panel headings only\n.panel-default > .panel-heading   { .panel-heading-styles(@panel-default-heading-bg); }\n.panel-primary > .panel-heading   { .panel-heading-styles(@panel-primary-heading-bg); }\n.panel-success > .panel-heading   { .panel-heading-styles(@panel-success-heading-bg); }\n.panel-info > .panel-heading      { .panel-heading-styles(@panel-info-heading-bg); }\n.panel-warning > .panel-heading   { .panel-heading-styles(@panel-warning-heading-bg); }\n.panel-danger > .panel-heading    { .panel-heading-styles(@panel-danger-heading-bg); }\n\n\n\n//\n// Wells\n// --------------------------------------------------\n\n.well {\n  #gradient > .vertical(@start-color: darken(@well-bg, 5%); @end-color: @well-bg);\n  border-color: darken(@well-bg, 10%);\n  @shadow: inset 0 1px 3px rgba(0,0,0,.05), 0 1px 0 rgba(255,255,255,.1);\n  .box-shadow(@shadow);\n}\n","thumbnails.less":"//\n// Thumbnails\n// --------------------------------------------------\n\n\n// Mixin and adjust the regular image class\n.thumbnail {\n  display: block;\n  padding: @thumbnail-padding;\n  margin-bottom: @line-height-computed;\n  line-height: @line-height-base;\n  background-color: @thumbnail-bg;\n  border: 1px solid @thumbnail-border;\n  border-radius: @thumbnail-border-radius;\n  .transition(all .2s ease-in-out);\n\n  > img,\n  a > img {\n    &:extend(.img-responsive);\n    margin-left: auto;\n    margin-right: auto;\n  }\n\n  // Add a hover state for linked versions only\n  a&:hover,\n  a&:focus,\n  a&.active {\n    border-color: @link-color;\n  }\n\n  // Image captions\n  .caption {\n    padding: @thumbnail-caption-padding;\n    color: @thumbnail-caption-color;\n  }\n}\n","tooltip.less":"//\n// Tooltips\n// --------------------------------------------------\n\n\n// Base class\n.tooltip {\n  position: absolute;\n  z-index: @zindex-tooltip;\n  display: block;\n  visibility: visible;\n  font-size: @font-size-small;\n  line-height: 1.4;\n  .opacity(0);\n\n  &.in     { .opacity(@tooltip-opacity); }\n  &.top    { margin-top:  -3px; padding: @tooltip-arrow-width 0; }\n  &.right  { margin-left:  3px; padding: 0 @tooltip-arrow-width; }\n  &.bottom { margin-top:   3px; padding: @tooltip-arrow-width 0; }\n  &.left   { margin-left: -3px; padding: 0 @tooltip-arrow-width; }\n}\n\n// Wrapper for the tooltip content\n.tooltip-inner {\n  max-width: @tooltip-max-width;\n  padding: 3px 8px;\n  color: @tooltip-color;\n  text-align: center;\n  text-decoration: none;\n  background-color: @tooltip-bg;\n  border-radius: @border-radius-base;\n}\n\n// Arrows\n.tooltip-arrow {\n  position: absolute;\n  width: 0;\n  height: 0;\n  border-color: transparent;\n  border-style: solid;\n}\n.tooltip {\n  &.top .tooltip-arrow {\n    bottom: 0;\n    left: 50%;\n    margin-left: -@tooltip-arrow-width;\n    border-width: @tooltip-arrow-width @tooltip-arrow-width 0;\n    border-top-color: @tooltip-arrow-color;\n  }\n  &.top-left .tooltip-arrow {\n    bottom: 0;\n    left: @tooltip-arrow-width;\n    border-width: @tooltip-arrow-width @tooltip-arrow-width 0;\n    border-top-color: @tooltip-arrow-color;\n  }\n  &.top-right .tooltip-arrow {\n    bottom: 0;\n    right: @tooltip-arrow-width;\n    border-width: @tooltip-arrow-width @tooltip-arrow-width 0;\n    border-top-color: @tooltip-arrow-color;\n  }\n  &.right .tooltip-arrow {\n    top: 50%;\n    left: 0;\n    margin-top: -@tooltip-arrow-width;\n    border-width: @tooltip-arrow-width @tooltip-arrow-width @tooltip-arrow-width 0;\n    border-right-color: @tooltip-arrow-color;\n  }\n  &.left .tooltip-arrow {\n    top: 50%;\n    right: 0;\n    margin-top: -@tooltip-arrow-width;\n    border-width: @tooltip-arrow-width 0 @tooltip-arrow-width @tooltip-arrow-width;\n    border-left-color: @tooltip-arrow-color;\n  }\n  &.bottom .tooltip-arrow {\n    top: 0;\n    left: 50%;\n    margin-left: -@tooltip-arrow-width;\n    border-width: 0 @tooltip-arrow-width @tooltip-arrow-width;\n    border-bottom-color: @tooltip-arrow-color;\n  }\n  &.bottom-left .tooltip-arrow {\n    top: 0;\n    left: @tooltip-arrow-width;\n    border-width: 0 @tooltip-arrow-width @tooltip-arrow-width;\n    border-bottom-color: @tooltip-arrow-color;\n  }\n  &.bottom-right .tooltip-arrow {\n    top: 0;\n    right: @tooltip-arrow-width;\n    border-width: 0 @tooltip-arrow-width @tooltip-arrow-width;\n    border-bottom-color: @tooltip-arrow-color;\n  }\n}\n","type.less":"//\n// Typography\n// --------------------------------------------------\n\n\n// Headings\n// -------------------------\n\nh1, h2, h3, h4, h5, h6,\n.h1, .h2, .h3, .h4, .h5, .h6 {\n  font-family: @headings-font-family;\n  font-weight: @headings-font-weight;\n  line-height: @headings-line-height;\n  color: @headings-color;\n\n  small,\n  .small {\n    font-weight: normal;\n    line-height: 1;\n    color: @headings-small-color;\n  }\n}\n\nh1, .h1,\nh2, .h2,\nh3, .h3 {\n  margin-top: @line-height-computed;\n  margin-bottom: (@line-height-computed / 2);\n\n  small,\n  .small {\n    font-size: 65%;\n  }\n}\nh4, .h4,\nh5, .h5,\nh6, .h6 {\n  margin-top: (@line-height-computed / 2);\n  margin-bottom: (@line-height-computed / 2);\n\n  small,\n  .small {\n    font-size: 75%;\n  }\n}\n\nh1, .h1 { font-size: @font-size-h1; }\nh2, .h2 { font-size: @font-size-h2; }\nh3, .h3 { font-size: @font-size-h3; }\nh4, .h4 { font-size: @font-size-h4; }\nh5, .h5 { font-size: @font-size-h5; }\nh6, .h6 { font-size: @font-size-h6; }\n\n\n// Body text\n// -------------------------\n\np {\n  margin: 0 0 (@line-height-computed / 2);\n}\n\n.lead {\n  margin-bottom: @line-height-computed;\n  font-size: floor((@font-size-base * 1.15));\n  font-weight: 200;\n  line-height: 1.4;\n\n  @media (min-width: @screen-sm-min) {\n    font-size: (@font-size-base * 1.5);\n  }\n}\n\n\n// Emphasis & misc\n// -------------------------\n\n// Ex: 14px base font * 85% = about 12px\nsmall,\n.small  { font-size: 85%; }\n\n// Undo browser default styling\ncite    { font-style: normal; }\n\n// Alignment\n.text-left           { text-align: left; }\n.text-right          { text-align: right; }\n.text-center         { text-align: center; }\n.text-justify        { text-align: justify; }\n\n// Contextual colors\n.text-muted {\n  color: @text-muted;\n}\n.text-primary {\n  .text-emphasis-variant(@brand-primary);\n}\n.text-success {\n  .text-emphasis-variant(@state-success-text);\n}\n.text-info {\n  .text-emphasis-variant(@state-info-text);\n}\n.text-warning {\n  .text-emphasis-variant(@state-warning-text);\n}\n.text-danger {\n  .text-emphasis-variant(@state-danger-text);\n}\n\n// Contextual backgrounds\n// For now we'll leave these alongside the text classes until v4 when we can\n// safely shift things around (per SemVer rules).\n.bg-primary {\n  // Given the contrast here, this is the only class to have its color inverted\n  // automatically.\n  color: #fff;\n  .bg-variant(@brand-primary);\n}\n.bg-success {\n  .bg-variant(@state-success-bg);\n}\n.bg-info {\n  .bg-variant(@state-info-bg);\n}\n.bg-warning {\n  .bg-variant(@state-warning-bg);\n}\n.bg-danger {\n  .bg-variant(@state-danger-bg);\n}\n\n\n// Page header\n// -------------------------\n\n.page-header {\n  padding-bottom: ((@line-height-computed / 2) - 1);\n  margin: (@line-height-computed * 2) 0 @line-height-computed;\n  border-bottom: 1px solid @page-header-border-color;\n}\n\n\n// Lists\n// --------------------------------------------------\n\n// Unordered and Ordered lists\nul,\nol {\n  margin-top: 0;\n  margin-bottom: (@line-height-computed / 2);\n  ul,\n  ol {\n    margin-bottom: 0;\n  }\n}\n\n// List options\n\n// Unstyled keeps list items block level, just removes default browser padding and list-style\n.list-unstyled {\n  padding-left: 0;\n  list-style: none;\n}\n\n// Inline turns list items into inline-block\n.list-inline {\n  .list-unstyled();\n  margin-left: -5px;\n\n  > li {\n    display: inline-block;\n    padding-left: 5px;\n    padding-right: 5px;\n  }\n}\n\n// Description Lists\ndl {\n  margin-top: 0; // Remove browser default\n  margin-bottom: @line-height-computed;\n}\ndt,\ndd {\n  line-height: @line-height-base;\n}\ndt {\n  font-weight: bold;\n}\ndd {\n  margin-left: 0; // Undo browser default\n}\n\n// Horizontal description lists\n//\n// Defaults to being stacked without any of the below styles applied, until the\n// grid breakpoint is reached (default of ~768px).\n\n@media (min-width: @grid-float-breakpoint) {\n  .dl-horizontal {\n    dt {\n      float: left;\n      width: (@component-offset-horizontal - 20);\n      clear: left;\n      text-align: right;\n      .text-overflow();\n    }\n    dd {\n      margin-left: @component-offset-horizontal;\n      &:extend(.clearfix all); // Clear the floated `dt` if an empty `dd` is present\n    }\n  }\n}\n\n// MISC\n// ----\n\n// Abbreviations and acronyms\nabbr[title],\n// Add data-* attribute to help out our tooltip plugin, per https://github.com/twbs/bootstrap/issues/5257\nabbr[data-original-title] {\n  cursor: help;\n  border-bottom: 1px dotted @abbr-border-color;\n}\n.initialism {\n  font-size: 90%;\n  text-transform: uppercase;\n}\n\n// Blockquotes\nblockquote {\n  padding: (@line-height-computed / 2) @line-height-computed;\n  margin: 0 0 @line-height-computed;\n  font-size: @blockquote-font-size;\n  border-left: 5px solid @blockquote-border-color;\n\n  p,\n  ul,\n  ol {\n    &:last-child {\n      margin-bottom: 0;\n    }\n  }\n\n  // Note: Deprecated small and .small as of v3.1.0\n  // Context: https://github.com/twbs/bootstrap/issues/11660\n  footer,\n  small,\n  .small {\n    display: block;\n    font-size: 80%; // back to default font-size\n    line-height: @line-height-base;\n    color: @blockquote-small-color;\n\n    &:before {\n      content: '\\2014 \\00A0'; // em dash, nbsp\n    }\n  }\n}\n\n// Opposite alignment of blockquote\n//\n// Heads up: `blockquote.pull-right` has been deprecated as of v3.1.0.\n.blockquote-reverse,\nblockquote.pull-right {\n  padding-right: 15px;\n  padding-left: 0;\n  border-right: 5px solid @blockquote-border-color;\n  border-left: 0;\n  text-align: right;\n\n  // Account for citation\n  footer,\n  small,\n  .small {\n    &:before { content: ''; }\n    &:after {\n      content: '\\00A0 \\2014'; // nbsp, em dash\n    }\n  }\n}\n\n// Quotes\nblockquote:before,\nblockquote:after {\n  content: \"\";\n}\n\n// Addresses\naddress {\n  margin-bottom: @line-height-computed;\n  font-style: normal;\n  line-height: @line-height-base;\n}\n","utilities.less":"//\n// Utility classes\n// --------------------------------------------------\n\n\n// Floats\n// -------------------------\n\n.clearfix {\n  .clearfix();\n}\n.center-block {\n  .center-block();\n}\n.pull-right {\n  float: right !important;\n}\n.pull-left {\n  float: left !important;\n}\n\n\n// Toggling content\n// -------------------------\n\n// Note: Deprecated .hide in favor of .hidden or .sr-only (as appropriate) in v3.0.1\n.hide {\n  display: none !important;\n}\n.show {\n  display: block !important;\n}\n.invisible {\n  visibility: hidden;\n}\n.text-hide {\n  .text-hide();\n}\n\n\n// Hide from screenreaders and browsers\n//\n// Credit: HTML5 Boilerplate\n\n.hidden {\n  display: none !important;\n  visibility: hidden !important;\n}\n\n\n// For Affix plugin\n// -------------------------\n\n.affix {\n  position: fixed;\n}\n","variables.less":"//\n// Variables\n// --------------------------------------------------\n\n\n//== Colors\n//\n//## Gray and brand colors for use across Bootstrap.\n\n@gray-darker:            lighten(#000, 13.5%); // #222\n@gray-dark:              lighten(#000, 20%);   // #333\n@gray:                   lighten(#000, 33.5%); // #555\n@gray-light:             lighten(#000, 60%);   // #999\n@gray-lighter:           lighten(#000, 93.5%); // #eee\n\n@brand-primary:         #428bca;\n@brand-success:         #5cb85c;\n@brand-info:            #5bc0de;\n@brand-warning:         #f0ad4e;\n@brand-danger:          #d9534f;\n\n\n//== Scaffolding\n//\n// ## Settings for some of the most global styles.\n\n//** Background color for `<body>`.\n@body-bg:               #fff;\n//** Global text color on `<body>`.\n@text-color:            @gray-dark;\n\n//** Global textual link color.\n@link-color:            @brand-primary;\n//** Link hover color set via `darken()` function.\n@link-hover-color:      darken(@link-color, 15%);\n\n\n//== Typography\n//\n//## Font, line-height, and color for body text, headings, and more.\n\n@font-family-sans-serif:  \"Helvetica Neue\", Helvetica, Arial, sans-serif;\n@font-family-serif:       Georgia, \"Times New Roman\", Times, serif;\n//** Default monospace fonts for `<code>`, `<kbd>`, and `<pre>`.\n@font-family-monospace:   Menlo, Monaco, Consolas, \"Courier New\", monospace;\n@font-family-base:        @font-family-sans-serif;\n\n@font-size-base:          14px;\n@font-size-large:         ceil((@font-size-base * 1.25)); // ~18px\n@font-size-small:         ceil((@font-size-base * 0.85)); // ~12px\n\n@font-size-h1:            floor((@font-size-base * 2.6)); // ~36px\n@font-size-h2:            floor((@font-size-base * 2.15)); // ~30px\n@font-size-h3:            ceil((@font-size-base * 1.7)); // ~24px\n@font-size-h4:            ceil((@font-size-base * 1.25)); // ~18px\n@font-size-h5:            @font-size-base;\n@font-size-h6:            ceil((@font-size-base * 0.85)); // ~12px\n\n//** Unit-less `line-height` for use in components like buttons.\n@line-height-base:        1.428571429; // 20/14\n//** Computed \"line-height\" (`font-size` * `line-height`) for use with `margin`, `padding`, etc.\n@line-height-computed:    floor((@font-size-base * @line-height-base)); // ~20px\n\n//** By default, this inherits from the `<body>`.\n@headings-font-family:    inherit;\n@headings-font-weight:    500;\n@headings-line-height:    1.1;\n@headings-color:          inherit;\n\n\n//-- Iconography\n//\n//## Specify custom locations of the include Glyphicons icon font. Useful for those including Bootstrap via Bower.\n\n@icon-font-path:          \"../fonts/\";\n@icon-font-name:          \"glyphicons-halflings-regular\";\n@icon-font-svg-id:        \"glyphicons_halflingsregular\";\n\n//== Components\n//\n//## Define common padding and border radius sizes and more. Values based on 14px text and 1.428 line-height (~20px to start).\n\n@padding-base-vertical:     6px;\n@padding-base-horizontal:   12px;\n\n@padding-large-vertical:    10px;\n@padding-large-horizontal:  16px;\n\n@padding-small-vertical:    5px;\n@padding-small-horizontal:  10px;\n\n@padding-xs-vertical:       1px;\n@padding-xs-horizontal:     5px;\n\n@line-height-large:         1.33;\n@line-height-small:         1.5;\n\n@border-radius-base:        4px;\n@border-radius-large:       6px;\n@border-radius-small:       3px;\n\n//** Global color for active items (e.g., navs or dropdowns).\n@component-active-color:    #fff;\n//** Global background color for active items (e.g., navs or dropdowns).\n@component-active-bg:       @brand-primary;\n\n//** Width of the `border` for generating carets that indicator dropdowns.\n@caret-width-base:          4px;\n//** Carets increase slightly in size for larger components.\n@caret-width-large:         5px;\n\n\n//== Tables\n//\n//## Customizes the `.table` component with basic values, each used across all table variations.\n\n//** Padding for `<th>`s and `<td>`s.\n@table-cell-padding:            8px;\n//** Padding for cells in `.table-condensed`.\n@table-condensed-cell-padding:  5px;\n\n//** Default background color used for all tables.\n@table-bg:                      transparent;\n//** Background color used for `.table-striped`.\n@table-bg-accent:               #f9f9f9;\n//** Background color used for `.table-hover`.\n@table-bg-hover:                #f5f5f5;\n@table-bg-active:               @table-bg-hover;\n\n//** Border color for table and cell borders.\n@table-border-color:            #ddd;\n\n\n//== Buttons\n//\n//## For each of Bootstrap's buttons, define text, background and border color.\n\n@btn-font-weight:                normal;\n\n@btn-default-color:              #333;\n@btn-default-bg:                 #fff;\n@btn-default-border:             #ccc;\n\n@btn-primary-color:              #fff;\n@btn-primary-bg:                 @brand-primary;\n@btn-primary-border:             darken(@btn-primary-bg, 5%);\n\n@btn-success-color:              #fff;\n@btn-success-bg:                 @brand-success;\n@btn-success-border:             darken(@btn-success-bg, 5%);\n\n@btn-info-color:                 #fff;\n@btn-info-bg:                    @brand-info;\n@btn-info-border:                darken(@btn-info-bg, 5%);\n\n@btn-warning-color:              #fff;\n@btn-warning-bg:                 @brand-warning;\n@btn-warning-border:             darken(@btn-warning-bg, 5%);\n\n@btn-danger-color:               #fff;\n@btn-danger-bg:                  @brand-danger;\n@btn-danger-border:              darken(@btn-danger-bg, 5%);\n\n@btn-link-disabled-color:        @gray-light;\n\n\n//== Forms\n//\n//##\n\n//** `<input>` background color\n@input-bg:                       #fff;\n//** `<input disabled>` background color\n@input-bg-disabled:              @gray-lighter;\n\n//** Text color for `<input>`s\n@input-color:                    @gray;\n//** `<input>` border color\n@input-border:                   #ccc;\n//** `<input>` border radius\n@input-border-radius:            @border-radius-base;\n//** Border color for inputs on focus\n@input-border-focus:             #66afe9;\n\n//** Placeholder text color\n@input-color-placeholder:        @gray-light;\n\n//** Default `.form-control` height\n@input-height-base:              (@line-height-computed + (@padding-base-vertical * 2) + 2);\n//** Large `.form-control` height\n@input-height-large:             (ceil(@font-size-large * @line-height-large) + (@padding-large-vertical * 2) + 2);\n//** Small `.form-control` height\n@input-height-small:             (floor(@font-size-small * @line-height-small) + (@padding-small-vertical * 2) + 2);\n\n@legend-color:                   @gray-dark;\n@legend-border-color:            #e5e5e5;\n\n//** Background color for textual input addons\n@input-group-addon-bg:           @gray-lighter;\n//** Border color for textual input addons\n@input-group-addon-border-color: @input-border;\n\n\n//== Dropdowns\n//\n//## Dropdown menu container and contents.\n\n//** Background for the dropdown menu.\n@dropdown-bg:                    #fff;\n//** Dropdown menu `border-color`.\n@dropdown-border:                rgba(0,0,0,.15);\n//** Dropdown menu `border-color` **for IE8**.\n@dropdown-fallback-border:       #ccc;\n//** Divider color for between dropdown items.\n@dropdown-divider-bg:            #e5e5e5;\n\n//** Dropdown link text color.\n@dropdown-link-color:            @gray-dark;\n//** Hover color for dropdown links.\n@dropdown-link-hover-color:      darken(@gray-dark, 5%);\n//** Hover background for dropdown links.\n@dropdown-link-hover-bg:         #f5f5f5;\n\n//** Active dropdown menu item text color.\n@dropdown-link-active-color:     @component-active-color;\n//** Active dropdown menu item background color.\n@dropdown-link-active-bg:        @component-active-bg;\n\n//** Disabled dropdown menu item background color.\n@dropdown-link-disabled-color:   @gray-light;\n\n//** Text color for headers within dropdown menus.\n@dropdown-header-color:          @gray-light;\n\n// Note: Deprecated @dropdown-caret-color as of v3.1.0\n@dropdown-caret-color:           #000;\n\n\n//-- Z-index master list\n//\n// Warning: Avoid customizing these values. They're used for a bird's eye view\n// of components dependent on the z-axis and are designed to all work together.\n//\n// Note: These variables are not generated into the Customizer.\n\n@zindex-navbar:            1000;\n@zindex-dropdown:          1000;\n@zindex-popover:           1010;\n@zindex-tooltip:           1030;\n@zindex-navbar-fixed:      1030;\n@zindex-modal-background:  1040;\n@zindex-modal:             1050;\n\n\n//== Media queries breakpoints\n//\n//## Define the breakpoints at which your layout will change, adapting to different screen sizes.\n\n// Extra small screen / phone\n// Note: Deprecated @screen-xs and @screen-phone as of v3.0.1\n@screen-xs:                  480px;\n@screen-xs-min:              @screen-xs;\n@screen-phone:               @screen-xs-min;\n\n// Small screen / tablet\n// Note: Deprecated @screen-sm and @screen-tablet as of v3.0.1\n@screen-sm:                  768px;\n@screen-sm-min:              @screen-sm;\n@screen-tablet:              @screen-sm-min;\n\n// Medium screen / desktop\n// Note: Deprecated @screen-md and @screen-desktop as of v3.0.1\n@screen-md:                  992px;\n@screen-md-min:              @screen-md;\n@screen-desktop:             @screen-md-min;\n\n// Large screen / wide desktop\n// Note: Deprecated @screen-lg and @screen-lg-desktop as of v3.0.1\n@screen-lg:                  1200px;\n@screen-lg-min:              @screen-lg;\n@screen-lg-desktop:          @screen-lg-min;\n\n// So media queries don't overlap when required, provide a maximum\n@screen-xs-max:              (@screen-sm-min - 1);\n@screen-sm-max:              (@screen-md-min - 1);\n@screen-md-max:              (@screen-lg-min - 1);\n\n\n//== Grid system\n//\n//## Define your custom responsive grid.\n\n//** Number of columns in the grid.\n@grid-columns:              12;\n//** Padding between columns. Gets divided in half for the left and right.\n@grid-gutter-width:         30px;\n// Navbar collapse\n//** Point at which the navbar becomes uncollapsed.\n@grid-float-breakpoint:     @screen-sm-min;\n//** Point at which the navbar begins collapsing.\n@grid-float-breakpoint-max: (@grid-float-breakpoint - 1);\n\n\n//== Container sizes\n//\n//## Define the maximum width of `.container` for different screen sizes.\n\n// Small screen / tablet\n@container-tablet:             ((720px + @grid-gutter-width));\n//** For `@screen-sm-min` and up.\n@container-sm:                 @container-tablet;\n\n// Medium screen / desktop\n@container-desktop:            ((940px + @grid-gutter-width));\n//** For `@screen-md-min` and up.\n@container-md:                 @container-desktop;\n\n// Large screen / wide desktop\n@container-large-desktop:      ((1140px + @grid-gutter-width));\n//** For `@screen-lg-min` and up.\n@container-lg:                 @container-large-desktop;\n\n\n//== Navbar\n//\n//##\n\n// Basics of a navbar\n@navbar-height:                    50px;\n@navbar-margin-bottom:             @line-height-computed;\n@navbar-border-radius:             @border-radius-base;\n@navbar-padding-horizontal:        floor((@grid-gutter-width / 2));\n@navbar-padding-vertical:          ((@navbar-height - @line-height-computed) / 2);\n@navbar-collapse-max-height:       340px;\n\n@navbar-default-color:             #777;\n@navbar-default-bg:                #f8f8f8;\n@navbar-default-border:            darken(@navbar-default-bg, 6.5%);\n\n// Navbar links\n@navbar-default-link-color:                #777;\n@navbar-default-link-hover-color:          #333;\n@navbar-default-link-hover-bg:             transparent;\n@navbar-default-link-active-color:         #555;\n@navbar-default-link-active-bg:            darken(@navbar-default-bg, 6.5%);\n@navbar-default-link-disabled-color:       #ccc;\n@navbar-default-link-disabled-bg:          transparent;\n\n// Navbar brand label\n@navbar-default-brand-color:               @navbar-default-link-color;\n@navbar-default-brand-hover-color:         darken(@navbar-default-brand-color, 10%);\n@navbar-default-brand-hover-bg:            transparent;\n\n// Navbar toggle\n@navbar-default-toggle-hover-bg:           #ddd;\n@navbar-default-toggle-icon-bar-bg:        #888;\n@navbar-default-toggle-border-color:       #ddd;\n\n\n// Inverted navbar\n// Reset inverted navbar basics\n@navbar-inverse-color:                      @gray-light;\n@navbar-inverse-bg:                         #222;\n@navbar-inverse-border:                     darken(@navbar-inverse-bg, 10%);\n\n// Inverted navbar links\n@navbar-inverse-link-color:                 @gray-light;\n@navbar-inverse-link-hover-color:           #fff;\n@navbar-inverse-link-hover-bg:              transparent;\n@navbar-inverse-link-active-color:          @navbar-inverse-link-hover-color;\n@navbar-inverse-link-active-bg:             darken(@navbar-inverse-bg, 10%);\n@navbar-inverse-link-disabled-color:        #444;\n@navbar-inverse-link-disabled-bg:           transparent;\n\n// Inverted navbar brand label\n@navbar-inverse-brand-color:                @navbar-inverse-link-color;\n@navbar-inverse-brand-hover-color:          #fff;\n@navbar-inverse-brand-hover-bg:             transparent;\n\n// Inverted navbar toggle\n@navbar-inverse-toggle-hover-bg:            #333;\n@navbar-inverse-toggle-icon-bar-bg:         #fff;\n@navbar-inverse-toggle-border-color:        #333;\n\n\n//== Navs\n//\n//##\n\n//=== Shared nav styles\n@nav-link-padding:                          10px 15px;\n@nav-link-hover-bg:                         @gray-lighter;\n\n@nav-disabled-link-color:                   @gray-light;\n@nav-disabled-link-hover-color:             @gray-light;\n\n@nav-open-link-hover-color:                 #fff;\n\n//== Tabs\n@nav-tabs-border-color:                     #ddd;\n\n@nav-tabs-link-hover-border-color:          @gray-lighter;\n\n@nav-tabs-active-link-hover-bg:             @body-bg;\n@nav-tabs-active-link-hover-color:          @gray;\n@nav-tabs-active-link-hover-border-color:   #ddd;\n\n@nav-tabs-justified-link-border-color:            #ddd;\n@nav-tabs-justified-active-link-border-color:     @body-bg;\n\n//== Pills\n@nav-pills-border-radius:                   @border-radius-base;\n@nav-pills-active-link-hover-bg:            @component-active-bg;\n@nav-pills-active-link-hover-color:         @component-active-color;\n\n\n//== Pagination\n//\n//##\n\n@pagination-color:                     @link-color;\n@pagination-bg:                        #fff;\n@pagination-border:                    #ddd;\n\n@pagination-hover-color:               @link-hover-color;\n@pagination-hover-bg:                  @gray-lighter;\n@pagination-hover-border:              #ddd;\n\n@pagination-active-color:              #fff;\n@pagination-active-bg:                 @brand-primary;\n@pagination-active-border:             @brand-primary;\n\n@pagination-disabled-color:            @gray-light;\n@pagination-disabled-bg:               #fff;\n@pagination-disabled-border:           #ddd;\n\n\n//== Pager\n//\n//##\n\n@pager-bg:                             @pagination-bg;\n@pager-border:                         @pagination-border;\n@pager-border-radius:                  15px;\n\n@pager-hover-bg:                       @pagination-hover-bg;\n\n@pager-active-bg:                      @pagination-active-bg;\n@pager-active-color:                   @pagination-active-color;\n\n@pager-disabled-color:                 @pagination-disabled-color;\n\n\n//== Jumbotron\n//\n//##\n\n@jumbotron-padding:              30px;\n@jumbotron-color:                inherit;\n@jumbotron-bg:                   @gray-lighter;\n@jumbotron-heading-color:        inherit;\n@jumbotron-font-size:            ceil((@font-size-base * 1.5));\n\n\n//== Form states and alerts\n//\n//## Define colors for form feedback states and, by default, alerts.\n\n@state-success-text:             #3c763d;\n@state-success-bg:               #dff0d8;\n@state-success-border:           darken(spin(@state-success-bg, -10), 5%);\n\n@state-info-text:                #31708f;\n@state-info-bg:                  #d9edf7;\n@state-info-border:              darken(spin(@state-info-bg, -10), 7%);\n\n@state-warning-text:             #8a6d3b;\n@state-warning-bg:               #fcf8e3;\n@state-warning-border:           darken(spin(@state-warning-bg, -10), 5%);\n\n@state-danger-text:              #a94442;\n@state-danger-bg:                #f2dede;\n@state-danger-border:            darken(spin(@state-danger-bg, -10), 5%);\n\n\n//== Tooltips\n//\n//##\n\n//** Tooltip max width\n@tooltip-max-width:           200px;\n//** Tooltip text color\n@tooltip-color:               #fff;\n//** Tooltip background color\n@tooltip-bg:                  #000;\n@tooltip-opacity:             .9;\n\n//** Tooltip arrow width\n@tooltip-arrow-width:         5px;\n//** Tooltip arrow color\n@tooltip-arrow-color:         @tooltip-bg;\n\n\n//== Popovers\n//\n//##\n\n//** Popover body background color\n@popover-bg:                          #fff;\n//** Popover maximum width\n@popover-max-width:                   276px;\n//** Popover border color\n@popover-border-color:                rgba(0,0,0,.2);\n//** Popover fallback border color\n@popover-fallback-border-color:       #ccc;\n\n//** Popover title background color\n@popover-title-bg:                    darken(@popover-bg, 3%);\n\n//** Popover arrow width\n@popover-arrow-width:                 10px;\n//** Popover arrow color\n@popover-arrow-color:                 #fff;\n\n//** Popover outer arrow width\n@popover-arrow-outer-width:           (@popover-arrow-width + 1);\n//** Popover outer arrow color\n@popover-arrow-outer-color:           fadein(@popover-border-color, 5%);\n//** Popover outer arrow fallback color\n@popover-arrow-outer-fallback-color:  darken(@popover-fallback-border-color, 20%);\n\n\n//== Labels\n//\n//##\n\n//** Default label background color\n@label-default-bg:            @gray-light;\n//** Primary label background color\n@label-primary-bg:            @brand-primary;\n//** Success label background color\n@label-success-bg:            @brand-success;\n//** Info label background color\n@label-info-bg:               @brand-info;\n//** Warning label background color\n@label-warning-bg:            @brand-warning;\n//** Danger label background color\n@label-danger-bg:             @brand-danger;\n\n//** Default label text color\n@label-color:                 #fff;\n//** Default text color of a linked label\n@label-link-hover-color:      #fff;\n\n\n//== Modals\n//\n//##\n\n//** Padding applied to the modal body\n@modal-inner-padding:         20px;\n\n//** Padding applied to the modal title\n@modal-title-padding:         15px;\n//** Modal title line-height\n@modal-title-line-height:     @line-height-base;\n\n//** Background color of modal content area\n@modal-content-bg:                             #fff;\n//** Modal content border color\n@modal-content-border-color:                   rgba(0,0,0,.2);\n//** Modal content border color **for IE8**\n@modal-content-fallback-border-color:          #999;\n\n//** Modal backdrop background color\n@modal-backdrop-bg:           #000;\n//** Modal backdrop opacity\n@modal-backdrop-opacity:      .5;\n//** Modal header border color\n@modal-header-border-color:   #e5e5e5;\n//** Modal footer border color\n@modal-footer-border-color:   @modal-header-border-color;\n\n@modal-lg:                    900px;\n@modal-md:                    600px;\n@modal-sm:                    300px;\n\n\n//== Alerts\n//\n//## Define alert colors, border radius, and padding.\n\n@alert-padding:               15px;\n@alert-border-radius:         @border-radius-base;\n@alert-link-font-weight:      bold;\n\n@alert-success-bg:            @state-success-bg;\n@alert-success-text:          @state-success-text;\n@alert-success-border:        @state-success-border;\n\n@alert-info-bg:               @state-info-bg;\n@alert-info-text:             @state-info-text;\n@alert-info-border:           @state-info-border;\n\n@alert-warning-bg:            @state-warning-bg;\n@alert-warning-text:          @state-warning-text;\n@alert-warning-border:        @state-warning-border;\n\n@alert-danger-bg:             @state-danger-bg;\n@alert-danger-text:           @state-danger-text;\n@alert-danger-border:         @state-danger-border;\n\n\n//== Progress bars\n//\n//##\n\n//** Background color of the whole progress component\n@progress-bg:                 #f5f5f5;\n//** Progress bar text color\n@progress-bar-color:          #fff;\n\n//** Default progress bar color\n@progress-bar-bg:             @brand-primary;\n//** Success progress bar color\n@progress-bar-success-bg:     @brand-success;\n//** Warning progress bar color\n@progress-bar-warning-bg:     @brand-warning;\n//** Danger progress bar color\n@progress-bar-danger-bg:      @brand-danger;\n//** Info progress bar color\n@progress-bar-info-bg:        @brand-info;\n\n\n//== List group\n//\n//##\n\n//** Background color on `.list-group-item`\n@list-group-bg:                 #fff;\n//** `.list-group-item` border color\n@list-group-border:             #ddd;\n//** List group border radius\n@list-group-border-radius:      @border-radius-base;\n\n//** Background color of single list elements on hover\n@list-group-hover-bg:           #f5f5f5;\n//** Text color of active list elements\n@list-group-active-color:       @component-active-color;\n//** Background color of active list elements\n@list-group-active-bg:          @component-active-bg;\n//** Border color of active list elements\n@list-group-active-border:      @list-group-active-bg;\n@list-group-active-text-color:  lighten(@list-group-active-bg, 40%);\n\n@list-group-link-color:         #555;\n@list-group-link-heading-color: #333;\n\n\n//== Panels\n//\n//##\n\n@panel-bg:                    #fff;\n@panel-body-padding:          15px;\n@panel-border-radius:         @border-radius-base;\n\n//** Border color for elements within panels\n@panel-inner-border:          #ddd;\n@panel-footer-bg:             #f5f5f5;\n\n@panel-default-text:          @gray-dark;\n@panel-default-border:        #ddd;\n@panel-default-heading-bg:    #f5f5f5;\n\n@panel-primary-text:          #fff;\n@panel-primary-border:        @brand-primary;\n@panel-primary-heading-bg:    @brand-primary;\n\n@panel-success-text:          @state-success-text;\n@panel-success-border:        @state-success-border;\n@panel-success-heading-bg:    @state-success-bg;\n\n@panel-info-text:             @state-info-text;\n@panel-info-border:           @state-info-border;\n@panel-info-heading-bg:       @state-info-bg;\n\n@panel-warning-text:          @state-warning-text;\n@panel-warning-border:        @state-warning-border;\n@panel-warning-heading-bg:    @state-warning-bg;\n\n@panel-danger-text:           @state-danger-text;\n@panel-danger-border:         @state-danger-border;\n@panel-danger-heading-bg:     @state-danger-bg;\n\n\n//== Thumbnails\n//\n//##\n\n//** Padding around the thumbnail image\n@thumbnail-padding:           4px;\n//** Thumbnail background color\n@thumbnail-bg:                @body-bg;\n//** Thumbnail border color\n@thumbnail-border:            #ddd;\n//** Thumbnail border radius\n@thumbnail-border-radius:     @border-radius-base;\n\n//** Custom text color for thumbnail captions\n@thumbnail-caption-color:     @text-color;\n//** Padding around the thumbnail caption\n@thumbnail-caption-padding:   9px;\n\n\n//== Wells\n//\n//##\n\n@well-bg:                     #f5f5f5;\n@well-border:                 darken(@well-bg, 7%);\n\n\n//== Badges\n//\n//##\n\n@badge-color:                 #fff;\n//** Linked badge text color on hover\n@badge-link-hover-color:      #fff;\n@badge-bg:                    @gray-light;\n\n//** Badge text color in active nav link\n@badge-active-color:          @link-color;\n//** Badge background color in active nav link\n@badge-active-bg:             #fff;\n\n@badge-font-weight:           bold;\n@badge-line-height:           1;\n@badge-border-radius:         10px;\n\n\n//== Breadcrumbs\n//\n//##\n\n@breadcrumb-padding-vertical:   8px;\n@breadcrumb-padding-horizontal: 15px;\n//** Breadcrumb background color\n@breadcrumb-bg:                 #f5f5f5;\n//** Breadcrumb text color\n@breadcrumb-color:              #ccc;\n//** Text color of current page in the breadcrumb\n@breadcrumb-active-color:       @gray-light;\n//** Textual separator for between breadcrumb elements\n@breadcrumb-separator:          \"/\";\n\n\n//== Carousel\n//\n//##\n\n@carousel-text-shadow:                        0 1px 2px rgba(0,0,0,.6);\n\n@carousel-control-color:                      #fff;\n@carousel-control-width:                      15%;\n@carousel-control-opacity:                    .5;\n@carousel-control-font-size:                  20px;\n\n@carousel-indicator-active-bg:                #fff;\n@carousel-indicator-border-color:             #fff;\n\n@carousel-caption-color:                      #fff;\n\n\n//== Close\n//\n//##\n\n@close-font-weight:           bold;\n@close-color:                 #000;\n@close-text-shadow:           0 1px 0 #fff;\n\n\n//== Code\n//\n//##\n\n@code-color:                  #c7254e;\n@code-bg:                     #f9f2f4;\n\n@kbd-color:                   #fff;\n@kbd-bg:                      #333;\n\n@pre-bg:                      #f5f5f5;\n@pre-color:                   @gray-dark;\n@pre-border-color:            #ccc;\n@pre-scrollable-max-height:   340px;\n\n\n//== Type\n//\n//##\n\n//** Text muted color\n@text-muted:                  @gray-light;\n//** Abbreviations and acronyms border color\n@abbr-border-color:           @gray-light;\n//** Headings small color\n@headings-small-color:        @gray-light;\n//** Blockquote small color\n@blockquote-small-color:      @gray-light;\n//** Blockquote font size\n@blockquote-font-size:        (@font-size-base * 1.25);\n//** Blockquote border color\n@blockquote-border-color:     @gray-lighter;\n//** Page header border color\n@page-header-border-color:    @gray-lighter;\n\n\n//== Miscellaneous\n//\n//##\n\n//** Horizontal line color.\n@hr-border:                   @gray-lighter;\n\n//** Horizontal offset for forms and lists.\n@component-offset-horizontal: 180px;\n","wells.less":"//\n// Wells\n// --------------------------------------------------\n\n\n// Base class\n.well {\n  min-height: 20px;\n  padding: 19px;\n  margin-bottom: 20px;\n  background-color: @well-bg;\n  border: 1px solid @well-border;\n  border-radius: @border-radius-base;\n  .box-shadow(inset 0 1px 1px rgba(0,0,0,.05));\n  blockquote {\n    border-color: #ddd;\n    border-color: rgba(0,0,0,.15);\n  }\n}\n\n// Sizes\n.well-lg {\n  padding: 24px;\n  border-radius: @border-radius-large;\n}\n.well-sm {\n  padding: 9px;\n  border-radius: @border-radius-small;\n}\n"};

//Copy from bootstrap grunt bs-lessdoc-parser.js
(function() {

function markdown2html(markdownString) {
  return markdown.toHTML(markdownString);
}
/*
Mini-language:
  //== This is a normal heading, which starts a section. Sections group variables together.
  //## Optional description for the heading

  //=== This is a subheading.

  //** Optional description for the following variable. You **can** use Markdown in descriptions to discuss `<html>` stuff.
  @foo: #ffff;

  //-- This is a heading for a section whose variables shouldn't be customizable

  All other lines are ignored completely.
*/


var CUSTOMIZABLE_HEADING = /^[/]{2}={2}(.*)$/;
var UNCUSTOMIZABLE_HEADING = /^[/]{2}-{2}(.*)$/;
var SUBSECTION_HEADING = /^[/]{2}={3}(.*)$/;
var SECTION_DOCSTRING = /^[/]{2}#{2}(.*)$/;
var VAR_ASSIGNMENT = /^(@[a-zA-Z0-9_-]+):[ ]*([^ ;][^;]+);[ ]*$/;
var VAR_DOCSTRING = /^[/]{2}[*]{2}(.*)$/;

function Section(heading, customizable) {
  this.heading = heading.trim();
  this.id = this.heading.replace(/\s+/g, '-').toLowerCase();
  this.customizable = customizable;
  this.docstring = null;
  this.subsections = [];
}

Section.prototype.addSubSection = function (subsection) {
  this.subsections.push(subsection);
};

function SubSection(heading) {
  this.heading = heading.trim();
  this.id = this.heading.replace(/\s+/g, '-').toLowerCase();
  this.variables = [];
}

SubSection.prototype.addVar = function (variable) {
  this.variables.push(variable);
};

function VarDocstring(markdownString) {
  this.html = markdown2html(markdownString);
}

function SectionDocstring(markdownString) {
  this.html = markdown2html(markdownString);
}

function Variable(name, defaultValue) {
  this.name = name;
  this.defaultValue = defaultValue;
  this.docstring = null;
}

function Tokenizer(fileContent) {
  this._lines = fileContent.split('\n');
  this._next = undefined;
}

Tokenizer.prototype.unshift = function (token) {
  if (this._next !== undefined) {
    throw new Error('Attempted to unshift twice!');
  }
  this._next = token;
};

Tokenizer.prototype._shift = function () {
  // returning null signals EOF
  // returning undefined means the line was ignored
  if (this._next !== undefined) {
    var result = this._next;
    this._next = undefined;
    return result;
  }
  if (this._lines.length <= 0) {
    return null;
  }
  var line = this._lines.shift();
  var match = null;
  match = SUBSECTION_HEADING.exec(line);
  if (match !== null) {
    return new SubSection(match[1]);
  }
  match = CUSTOMIZABLE_HEADING.exec(line);
  if (match !== null) {
    return new Section(match[1], true);
  }
  match = UNCUSTOMIZABLE_HEADING.exec(line);
  if (match !== null) {
    return new Section(match[1], false);
  }
  match = SECTION_DOCSTRING.exec(line);
  if (match !== null) {
    return new SectionDocstring(match[1]);
  }
  match = VAR_DOCSTRING.exec(line);
  if (match !== null) {
    return new VarDocstring(match[1]);
  }
  var commentStart = line.lastIndexOf('//');
  var varLine = (commentStart === -1) ? line : line.slice(0, commentStart);
  match = VAR_ASSIGNMENT.exec(varLine);
  if (match !== null) {
    return new Variable(match[1], match[2]);
  }
  return undefined;
};

Tokenizer.prototype.shift = function () {
  while (true) {
    var result = this._shift();
    if (result === undefined) {
      continue;
    }
    return result;
  }
};

function Parser(fileContent) {
  this._tokenizer = new Tokenizer(fileContent);
}

Parser.prototype.parseFile = function () {
  var sections = [];
  while (true) {
    var section = this.parseSection();
    if (section === null) {
      if (this._tokenizer.shift() !== null) {
        throw new Error('Unexpected unparsed section of file remains!');
      }
      return sections;
    }
    sections.push(section);
  }
};

Parser.prototype.parseSection = function () {
  var section = this._tokenizer.shift();
  if (section === null) {
    return null;
  }
  if (!(section instanceof Section)) {
    throw new Error('Expected section heading; got: ' + JSON.stringify(section));
  }
  var docstring = this._tokenizer.shift();
  if (docstring instanceof SectionDocstring) {
    section.docstring = docstring;
  }
  else {
    this._tokenizer.unshift(docstring);
  }
  this.parseSubSections(section);

  return section;
};

Parser.prototype.parseSubSections = function (section) {
  while (true) {
    var subsection = this.parseSubSection();
    if (subsection === null) {
      if (section.subsections.length === 0) {
        // Presume an implicit initial subsection
        subsection = new SubSection('');
        this.parseVars(subsection);
      }
      else {
        break;
      }
    }
    section.addSubSection(subsection);
  }

  if (section.subsections.length === 1 && !(section.subsections[0].heading) && section.subsections[0].variables.length === 0) {
    // Ignore lone empty implicit subsection
    section.subsections = [];
  }
};

Parser.prototype.parseSubSection = function () {
  var subsection = this._tokenizer.shift();
  if (subsection instanceof SubSection) {
    this.parseVars(subsection);
    return subsection;
  }
  this._tokenizer.unshift(subsection);
  return null;
};

Parser.prototype.parseVars = function (subsection) {
  while (true) {
    var variable = this.parseVar();
    if (variable === null) {
      return;
    }
    subsection.addVar(variable);
  }
};

Parser.prototype.parseVar = function () {
  var docstring = this._tokenizer.shift();
  if (!(docstring instanceof VarDocstring)) {
    this._tokenizer.unshift(docstring);
    docstring = null;
  }
  var variable = this._tokenizer.shift();
  if (variable instanceof Variable) {
    variable.docstring = docstring;
    return variable;
  }
  this._tokenizer.unshift(variable);
  return null;
};

window.LessParser = Parser;
})()


