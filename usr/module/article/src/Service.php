<?php
/**
 * Pi Engine (http://pialog.org)
 *
 * @link         http://code.pialog.org for the Pi Engine source repository
 * @copyright    Copyright (c) Pi Engine http://pialog.org
 * @license      http://pialog.org/license.txt New BSD License
 */

namespace Module\Article;

use Pi;
use Zend\Db\Sql\Expression;
use Module\Article\Model\Article;
use Pi\Mvc\Controller\ActionController;
use Module\Article\Controller\Admin\SetupController as Config;
use Module\Article\Form\DraftEditForm;
use Module\Article\Model\Draft;
use Module\Article\Compiled;
use Module\Article\Media;
use Module\Article\Installer\Resource\Route;

trigger_error(sprintf('The class is discouraged, move corresponding methods to relevant APIs - %s', __FILE__), E_USER_WARNING);

/**
 * Common service API
 * 
 * @author Zongshu Lin <lin40553024@163.com> 
 */
class Service
{
    protected static $module = 'article';

    /**
     * Assign configuration data to template
     * 
     * @param ActionController  $handler  ActionController instance
     */
    public static function setModuleConfig(ActionController $handler)
    {
        $module = Pi::service('module')->current();
        $handler->view()->assign(array(
            'authorSize'       => $handler->config('author_size'),
            'categoryWidth'    => $handler->config('category_width'),
            'categoryHeight'   => $handler->config('category_height'),
            'topicWidth'       => $handler->config('topic_width'),
            'topicHeight'      => $handler->config('topic_height'),
            'featureWidth'     => $handler->config('feature_width'),
            'featureHeight'    => $handler->config('feature_height'),
            'imageExtension'   => array_map('trim', explode(',', $handler->config('image_extension'))),
            'defaultMediaImage' => Pi::service('asset')
                ->getModuleAsset(
                    $handler->config('default_media_image'),
                    $module
                ),
            'defaultMediaThumb' => Pi::service('asset')
                ->getModuleAsset(
                    $handler->config('default_media_thumb'),
                    $module
                ),
            'maxMediaSize'      => Media::transferSize($handler->config('max_media_size')),
        ));
    }
    
    /**
     * Get param post by post, get or query.
     * 
     * @param ActionController $handler
     * @param string  $param    Parameter key
     * @param mixed   $default  Default value if parameter is no exists
     * @return mixed 
     */
    public static function getParam(
        ActionController $handler = null, 
        $param = null, 
        $default = null
    ) {      
        // Route parameter first
        $result = $handler->params()->fromRoute($param);

        // Then query string
        if (is_null($result) || '' === $result) {
            $result = $handler->params()->fromQuery($param);

            // Then post data
            if (is_null($result) || '' === $result) {
                $result = $handler->params()->fromPost($param);

                if (is_null($result) || '' === $result) {
                    $result = $default;
                }
            }
        }

        return $result;
    }

    /**
     * Get draft page
     * 
     * @param array  $where
     * @param int    $page
     * @param int    $limit
     * @param array  $columns
     * @param string $order
     * @param string $module
     * @return array
     */
    public static function getDraftPage(
        $where, 
        $page, 
        $limit, 
        $columns = null, 
        $order = null, 
        $module = null
    ) {
        $offset     = ($limit && $page) ? $limit * ($page - 1) : null;

        $module     = $module ?: Pi::service('module')->current();
        $draftIds   = $userIds = $authorIds = $categoryIds = array();
        $categories = $authors = $users = $tags = $urls = array();

        $modelDraft     = Pi::model('draft', $module);
        $modelAuthor    = Pi::model('author', $module);

        $resultset = $modelDraft->getSearchRows($where, $limit, $offset, $columns, $order);

        if ($resultset) {
            foreach ($resultset as $row) {
                $draftIds[] = $row['id'];

                if (!empty($row['author'])) {
                    $authorIds[] = $row['author'];
                }

                if (!empty($row['uid'])) {
                    $userIds[] = $row['uid'];
                }
            }
            $authorIds = array_unique($authorIds);
            $userIds   = array_unique($userIds);

            $categories = self::getCategoryList();

            if (!empty($authorIds)) {
                $resultsetAuthor = $modelAuthor->find($authorIds);
                foreach ($resultsetAuthor as $row) {
                    $authors[$row->id] = array(
                        'name' => $row->name,
                    );
                }
                unset($resultsetAuthor);
            }

            if (!empty($userIds)) {
                $resultsetUser = Pi::user()
                    ->get($userIds, array('id', 'identity'));
                foreach ($resultsetUser as $row) {
                    $users[$row['id']] = array(
                        'name' => $row['identity'],
                    );
                }
                unset($resultsetUser);
            }

            foreach ($resultset as &$row) {
                if (empty($columns) || isset($columns['category'])) {
                    $row['category_title'] = $categories[$row['category']]['title'];
                }

                if (empty($columns) || isset($columns['uid'])) {
                    if (!empty($users[$row['uid']])) {
                        $row['user_name'] = $users[$row['uid']]['name'];
                    }
                }

                if (empty($columns) || isset($columns['author'])) {
                    if (!empty($authors[$row['author']])) {
                        $row['author_name'] = $authors[$row['author']]['name'];
                    }
                }

                if (empty($columns) || isset($columns['image'])) {
                    if ($row['image']) {
                        $row['thumb'] = self::getThumbFromOriginal($row['image']);
                    }
                }
            }
        }

        return $resultset;
    }

    /**
     * Delete draft, along with featured image and attachment.
     * 
     * @param array   $ids     Draft ID
     * @param string  $module  Current module name
     * @return int             Affected rows
     */
    public static function deleteDraft($ids, $module = null)
    {
        $module         = $module ?: Pi::service('module')->current();

        $modelDraft     = Pi::model('draft', $module);
        $modelArticle   = Pi::model('article', $module);

        // Delete feature image
        $resultsetFeatureImage = $modelDraft->select(array('id' => $ids));
        foreach ($resultsetFeatureImage as $featureImage) {
            if ($featureImage->article) {
                $rowArticle = $modelArticle->find($featureImage->article);
                if ($featureImage->image 
                    && strcmp($featureImage->image, $rowArticle->image) != 0
                ) {
                    @unlink(Pi::path($featureImage->image));
                    @unlink(Pi::path(self::getThumbFromOriginal($featureImage->image)));
                }
            } else if ($featureImage->image) {
                @unlink(Pi::path($featureImage->image));
                @unlink(Pi::path(self::getThumbFromOriginal($featureImage->image)));
            }
        }

        // Delete assets
        $modelDraftAsset = Pi::model('asset_draft', $module);
        $modelDraftAsset->delete(array('draft' => $ids));

        // Delete draft
        $affectedRows = $modelDraft->delete(array('id' => $ids));

        return $affectedRows;
    }

    /**
     * Break article content by delimiter
     * 
     * @param string  $content
     * @return array
     */
    public static function breakPage($content)
    {
        $result = $matches = $row = array();
        $page   = 0;

        $matches = preg_split(
            Article::PAGE_BREAK_PATTERN, 
            $content, 
            null, 
            PREG_SPLIT_DELIM_CAPTURE | PREG_SPLIT_NO_EMPTY
        );
        foreach ($matches as $text) {
            if (preg_match(Article::PAGE_BREAK_PATTERN, $text)) {
                if (isset($row['title']) || isset($row['content'])) {
                    $row['page'] = ++$page;
                    $result[] = $row;
                    $row = array();
                }

                $row['title'] = trim(strip_tags($text));
            } else {
                $row['content'] = trim($text);
            }
        }

        if (!empty($row)) {
            $row['page'] = ++$page;
            $result[]    = $row;
        }

        return $result;
    }

    /**
     * Generate article summary
     * 
     * @param string  $content
     * @param int     $length
     * @return string
     */
    public static function generateArticleSummary($content, $length)
    {
        // Remove title
        $result = preg_replace(
            array(Article::PAGE_BREAK_PATTERN, '/&nbsp;/'), 
            '', 
            $content
        );
        // Strip tags
        $result = preg_replace('/<[^>]*>/', '', $result);
        // Trim blanks
        $result = trim($result);
        // Limit length
        $result = mb_substr($result, 0, $length, 'utf-8');

        return $result;
    }

    /**
     * Apply htmlspecialchars() on each value of an array
     *
     * @param mixed $data
     */
    public static function deepHtmlspecialchars($data)
    {
        if (is_array($data)) {
            foreach ($data as $key => $val) {
                $data[$key] = static::deepHtmlspecialchars($val);
            }
        } else {
            $data = is_string($data) 
                ? htmlspecialchars($data, ENT_QUOTES, 'utf-8') : $data;
        }

        return $data;
    }
    
    /**
     * Get count statistics of draft with different status and published article
     * 
     * @param string  $from
     * @return array 
     */
    public static function getSummary($from = 'my', $rules = array())
    {
        // Processing user managment category
        $categories = array_keys($rules);
                    
        $module = Pi::service('module')->current();
        
        $result = array(
            'published' => 0,
            'draft'     => 0,
            'pending'   => 0,
            'rejected'  => 0,
        );

        $where['article < ?'] = 1;
        if ('my' == $from) {
            $where['uid'] = Pi::user()->getId() ?: 0;
        }
        $modelDraft = Pi::model('draft', $module);
        $select     = $modelDraft->select()
            ->columns(array(
                'status', 
                'total' => new Expression('count(status)'), 
                'category'
            ))
            ->where($where)
            ->group(array('status', 'category'));
        $resultset  = $modelDraft->selectWith($select);
        foreach ($resultset as $row) {
            if (Draft::FIELD_STATUS_DRAFT == $row->status) {
                $result['draft'] += $row->total;
            } else if (Draft::FIELD_STATUS_PENDING == $row->status) {
                if ('all' == $from 
                    and in_array($row->category, $categories)
                ) {
                    $result['pending'] += $row->total;
                } elseif ('my' == $from) {
                    $result['pending'] += $row->total;
                }
            } else if (Draft::FIELD_STATUS_REJECTED == $row->status) {
                $result['rejected'] += $row->total;
            }
        }

        $modelArticle = Pi::model('article', $module);
        $where        = array(
            'status'   => Article::FIELD_STATUS_PUBLISHED,
            'category' => !empty($categories) ? $categories : 0,
        );
        if ('my' == $from) {
            $where['uid'] = Pi::user()->getId() ?: 0;
        }
        $select = $modelArticle->select()
            ->columns(array('total' => new Expression('count(id)')))
            ->where($where);
        $resultset = $modelArticle->selectWith($select);
        if ($resultset->count()) {
            $result['published'] = $resultset->current()->total;
        }

        return $result;
    }
    
    /**
     * Get draft article details.
     * 
     * @param int  $id  Draft article ID
     * @return array 
     */
    public static function getDraft($id)
    {
        $result = array();
        $module = Pi::service('module')->current();
        $config = Pi::service('module')->config('', $module);

        $row    = Pi::model('draft', $module)->findRow($id, 'id', false);
        if (empty($row->id)) {
            return array();
        }
        
        $subject = $subtitle = $content = '';
        if ($row->markup) {
            $subject    = Pi::service('markup')->render($row->subject, 'html', $row->markup);
            $subtitle   = Pi::service('markup')->render($row->subtitle, 'html', $row->markup);
        } else {
            $subject    = Pi::service('markup')->render($row->subject, 'html');
            $subtitle   = Pi::service('markup')->render($row->subtitle, 'html');
        }
        $content = Compiled::compiled($row->markup, $row->content, 'html');

        $result = array(
            'title'         => $subject,
            'content'       => Service::breakPage($content),
            'slug'          => $row->slug,
            'seo'           => array(
                'title'         => $row->seo_title,
                'keywords'      => $row->seo_keywords,
                'description'   => $row->seo_description,
            ),
            'subtitle'      => $subtitle,
            'source'        => $row->source,
            'pages'         => $row->pages,
            'time_publish'  => $row->time_publish,
            'author'        => array(),
            'attachment'    => array(),
            'tag'           => $row->tag,
            'related'       => array(),
            'category'      => $row->category,
        );

        // Get author
        if ($row->author) {
            $author = Pi::model('author', $module)->find($row->author);

            if ($author) {
                $result['author'] = $author->toArray();
                if (empty($result['author']['photo'])) {
                    $result['author']['photo'] = 
                        Pi::service('asset')->getModuleAsset(
                            $config['default_author_photo'], 
                            $module
                        );
                }
            }
        }

        // Get attachments
        $resultsetDraftAsset = Pi::model('asset_draft', $module)->select(array(
            'draft' => $id,
            'type'  => 'attachment',
        ));
        $mediaIds = array(0);
        foreach ($resultsetDraftAsset as $asset) {
            $mediaIds[$asset->media] = $asset->media;
        }

        $modelMedia = Pi::model('media', $module);
        $rowMedia   = $modelMedia->select(array('id' => $mediaIds));
        foreach ($rowMedia as $media) {
            $result['attachment'][] = array(
                'original_name' => $media->title,
                'extension'     => $media->type,
                'size'          => $media->size,
                'url'           => Pi::engine()->application()
                    ->getRouter()
                    ->assemble(
                        array(
                            'module'     => $module,
                            'controller' => 'media',
                            'action'     => 'download',
                            'name'       => $media->id,
                        ),
                        array(
                            'name'       => 'admin',
                        )
                    ),
            );
        }

        // Get related articles
        $relatedIds = $related = array();
        $relatedIds = $row->related;
        if ($relatedIds) {
            $related = array_flip($relatedIds);
            $where   = array('id' => $relatedIds);
            $columns = array('id', 'subject');

            $resultsetRelated = Entity::getArticlePage(
                $where, 
                1, 
                null, 
                $columns, 
                null, 
                $module
            );

            foreach ($resultsetRelated as $key => $val) {
                if (array_key_exists($key, $related)) {
                    $related[$key] = $val;
                }
            }

            $result['related'] = array_filter($related, function($var) {
                return is_array($var);
            });
        }

        if (empty($row->seo_keywords) && $config['seo_keywords']) {
            if ($config['seo_keywords'] == Article::FIELD_SEO_KEYWORDS_TAG) {
                $result['seo']['keywords'] = implode(' ', $result['tag']);
            } else if ($config['seo_keywords'] == Article::FIELD_SEO_KEYWORDS_CATEGORY) {
                $rowCategory = Pi::model('category', $module)->find($row->category);
                $result['seo']['keywords'] = $rowCategory->title;
            }
        }

        if (empty($row->seo_description) && $config['seo_description']) {
            if ($config['seo_description'] == Article::FIELD_SEO_DESCRIPTION_SUMMARY) {
                $result['seo']['description'] = $row->summary;
            }
        }

        return $result;
    }
    
    
    
    /**
     * Change status number to slug string
     * 
     * @param int  $status
     * @return string 
     */
    public static function getStatusSlug($status)
    {
        $slug = '';
        switch ($status) {
            case Draft::FIELD_STATUS_DRAFT:
                $slug = 'draft';
                break;
            case Draft::FIELD_STATUS_PENDING:
                $slug = 'pending';
                break;
            case Draft::FIELD_STATUS_REJECTED:
                $slug = 'approve';
                break;
            case Article::FIELD_STATUS_PUBLISHED:
                $slug = 'publish';
                break;
            default:
                $slug = 'draft';
                break;
        }
        
        return $slug;
    }
}
