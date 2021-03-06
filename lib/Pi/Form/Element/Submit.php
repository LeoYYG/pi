<?php
/**
 * Pi Engine (http://piengine.org)
 *
 * @link            http://code.piengine.org for the Pi Engine source repository
 * @copyright       Copyright (c) Pi Engine http://piengine.org
 * @license         http://piengine.org/license.txt BSD 3-Clause License
 * @package         Form
 */

namespace Pi\Form\Element;

use Laminas\Form\Element;

/**
 * Submit element
 *
 * @author Taiwen Jiang <taiwenjiang@tsinghua.org.cn>
 */
class Submit extends Element
{
    /**
     * Seed attributes
     *
     * @var array
     */
    protected $attributes
        = [
            'type'  => 'submit',
            'class' => 'btn btn-primary',
        ];

    /**
     * {@inheritDoc}
     */
    public function getValue()
    {
        if (null === $this->value) {
            $this->value = __('Submit');
        }

        return parent::getValue();
    }
}
