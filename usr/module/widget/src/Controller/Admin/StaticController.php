<?php
/**
 * Pi Engine (http://piengine.org)
 *
 * @link            http://code.piengine.org for the Pi Engine source repository
 * @copyright       Copyright (c) Pi Engine http://piengine.org
 * @license         http://piengine.org/license.txt BSD 3-Clause License
 */

namespace Module\Widget\Controller\Admin;

/**
 * For static block
 */
class StaticController extends WidgetController
{
    protected $type = 'html';

    /**
     * {@inheritDoc}
     */
    protected $editTemplate = 'system:component/form';

    /**
     * {@inheritDoc}
     */
    protected $formClass = 'BlockStaticForm';

    /**
     * Get content type list
     *
     * @return array
     */
    protected function contentTypes()
    {
        $contentTypes = [
            'html'     => _a('HTML'),
            'text'     => _a('Text'),
            'markdown' => _a('Markdown'),
        ];

        return $contentTypes;
    }

    /**
     * {@inheritDoc}
     */
    protected function widgetList($widgets = null)
    {
        $model   = $this->getModel('widget');
        $rowset  = $model->select([
            'type' => array_keys($this->contentTypes()),
        ]);
        $widgets = [];
        foreach ($rowset as $row) {
            $widgets[$row->block] = $row->toArray();
        }
        return parent::widgetList($widgets);
    }

    /**
     * {@inheritDoc}
     */
    public function addAction()
    {
        if ($this->request->isPost()) {
            $this->type = $this->request->getPost('type');
        } else {
            $this->type = $this->params('type', 'html');
        }
        parent::addAction();
    }

    /**
     * {@inheritDoc}
     */
    public function editAction()
    {
        if ($this->request->isPost()) {
            $id = $this->request->getPost('id');
        } else {
            $id = $this->params('id');
        }
        $widget     = $this->getModel('widget')->find($id);
        $this->type = $widget->type;
        parent::editAction();
    }
}
