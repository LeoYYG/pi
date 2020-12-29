<?php
/**
 * Pi Engine (http://piengine.org)
 *
 * @link            http://code.piengine.org for the Pi Engine source repository
 * @copyright       Copyright (c) Pi Engine http://piengine.org
 * @license         http://piengine.org/license.txt BSD 3-Clause License
 */

namespace Pi\Log\Formatter;

use Laminas\Log\Formatter\FormatterInterface;

/**
 * System information formatter
 *
 * @author Taiwen Jiang <taiwenjiang@tsinghua.org.cn>
 */
class SystemInfo implements FormatterInterface
{
    /** @var string Format specifier for log messages */
    protected $format;

    /** @var string DateTime format */
    protected $dateTimeFormat = 'H:i:s';

    /**
     * Class constructor
     *
     * @param null|string $format Format specifier for log messages
     *
     * @throws \Exception
     */
    public function __construct($format = null)
    {
        if ($format === null) {
            $format = '<div class="pi-event">' . PHP_EOL
                . '<div class="message info">'
                . '<dl class="dl-horizontal">'
                . '<dt>%name%</dt>'
                . '<dd>%value%</dd>'
                . '</dl>'
                . '</div>' . PHP_EOL
                . '</div>' . PHP_EOL;
        }

        $this->format = $format;
    }

    /**
     * Formats data into a single line to be written by the writer.
     *
     * @param array $event Event data
     *
     * @return string Formatted line to write to the log
     */
    public function format($event)
    {
        $output = $this->format;
        foreach ($event as $name => $value) {
            if (!is_scalar($value)) {
                continue;
            }
            $output = str_replace('%' . $name . '%', $value, $output);
        }

        return $output;
    }

    /**
     * {@inheritDoc}
     */
    public function getDateTimeFormat()
    {
        return $this->dateTimeFormat;
    }

    /**
     * {@inheritDoc}
     */
    public function setDateTimeFormat($dateTimeFormat)
    {
        $this->dateTimeFormat = (string)$dateTimeFormat;

        return $this;
    }
}
