<?php
/**
 * Pi Engine (http://piengine.org)
 *
 * @link            http://code.piengine.org for the Pi Engine source repository
 * @copyright       Copyright (c) Pi Engine http://piengine.org
 * @license         http://piengine.org/license.txt BSD 3-Clause License
 */

namespace Module\User\Api;

use Pi;
use Pi\Application\Api\AbstractApi;

/**
 * User relation APIs
 *
 * @author Taiwen Jiang <taiwenjiang@tsinghua.org.cn>
 */
class Relation extends AbstractApi
{
    /**
     * @{inheritDoc}
     */
    protected $module = 'user';

    /** @var array Relationship meta */
    protected $meta = [];

    /**
     * Set relationship meta
     *
     * @param array $meta
     *
     * @return $this
     */
    public function setMeta(array $meta)
    {
        $this->meta = $meta;

        return $this;
    }

    /**
     * Get relationship meta
     *
     * @return array
     */
    public function getMeta()
    {
        if (!$this->meta) {
            $this->meta = [
                'public'    => [
                    'level' => 0,
                    'title' => __('Public'),
                ],
                'member'    => [
                    'level' => 1,
                    'title' => __('Member'),
                ],
                'follower'  => [
                    'level' => 2,
                    'title' => __('Follower'),
                ],
                'following' => [
                    'level' => 4,
                    'title' => __('Following'),
                ],
                'owner'     => [
                    'level' => 255,
                    'title' => __('Owner'),
                ],
            ];
        }

        return $this->meta;
    }

    /**
     * Get relationship
     *
     * @param int $uid
     * @param int $target
     *
     * @return string
     */
    public function getRelation($uid, $target)
    {
        if ($uid == 0) {
            $result = 'public';
        } elseif ($uid == $target) {
            $result = 'owner';
        } else {
            $result = 'member';
        }

        return $result;
    }

    /**
     * Get relationship level
     *
     * @param int $uid
     * @param int $target
     *
     * @return int|null
     */
    public function getLevel($uid, $target)
    {
        $relation = $this->getRelation($uid, $target);
        $level    = isset($this->meta[$relation])
            ? $this->meta[$relation]['level'] : null;

        return $level;
    }

    /**
     * Get allowed/denied fields of a user
     *
     * @param int $uid
     * @param int|string $level
     * @param bool $allowed
     *
     * @return string[]
     */
    public function getFields($uid, $level, $allowed = false)
    {
        $level = is_numeric($level)
            ? (int)$level : $this->meta[$level]['level'];
        $where = ['uid' => $uid];
        if ($allowed) {
            $where['level <= ?'] = $level;
        } else {
            $where['level > ?'] = $level;
        }
        $rowset = Pi::model('privacy_user')->select($where);
        $fields = [];
        foreach ($rowset as $row) {
            $fields[] = $row['field'];
        }

        return $fields;
    }
}
