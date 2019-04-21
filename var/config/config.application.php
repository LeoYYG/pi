<?php
/**
 * Pi Engine (http://piengine.org)
 *
 * Pi Engine application configurations
 *
 * @link            http://code.piengine.org for the Pi Engine source repository
 * @copyright       Copyright (c) Pi Engine http://piengine.org
 * @license         http://piengine.org/license.txt BSD 3-Clause License
 * @author          Taiwen Jiang <taiwenjiang@tsinghua.org.cn>
 */

$defaultServiceConfig = [
    'aliases'            => [
        'configuration'                              => 'config',
        'Configuration'                              => 'config',
        'console'                                    => 'ConsoleAdapter',
        'Console'                                    => 'ConsoleAdapter',
        'ConsoleDefaultRenderingStrategy'            => View\Console\DefaultRenderingStrategy::class,
        'ControllerLoader'                           => 'ControllerManager',
        'Di'                                         => 'DependencyInjector',
        'HttpDefaultRenderingStrategy'               => View\Http\DefaultRenderingStrategy::class,
        //'MiddlewareListener'                       => 'Zend\Mvc\MiddlewareListener',
        //'RouteListener'                            => 'Zend\Mvc\RouteListener',
        //'SendResponseListener'                     => 'Zend\Mvc\SendResponseListener',
        'View'                                       => 'Zend\View\View',
        'ViewFeedRenderer'                           => 'Zend\View\Renderer\FeedRenderer',
        'ViewJsonRenderer'                           => 'Zend\View\Renderer\JsonRenderer',
        'ViewPhpRendererStrategy'                    => 'Zend\View\Strategy\PhpRendererStrategy',
        'ViewPhpRenderer'                            => 'Zend\View\Renderer\PhpRenderer',
        'ViewRenderer'                               => 'Zend\View\Renderer\PhpRenderer',
        'Zend\Di\LocatorInterface'                   => 'DependencyInjector',
        'Zend\Form\Annotation\FormAnnotationBuilder' => 'FormAnnotationBuilder',
        'Zend\Mvc\Controller\PluginManager'          => 'ControllerPluginManager',
        'Zend\Mvc\View\Http\InjectTemplateListener'  => 'InjectTemplateListener',
        'Zend\View\Renderer\RendererInterface'       => 'Zend\View\Renderer\PhpRenderer',
        'Zend\View\Resolver\TemplateMapResolver'     => 'ViewTemplateMapResolver',
        'Zend\View\Resolver\TemplatePathStack'       => 'ViewTemplatePathStack',
        'Zend\View\Resolver\AggregateResolver'       => 'ViewResolver',
        'Zend\View\Resolver\ResolverInterface'       => 'ViewResolver',
    ],
    'invokables'         => [
        'SharedEventManager'   => 'Zend\EventManager\SharedEventManager',

        // From ServiceListenerFactory
        //'DispatchListener'   => 'Zend\Mvc\DispatchListener',
        'RouteListener'        => 'Zend\Mvc\RouteListener',
        'MiddlewareListener'   => 'Zend\Mvc\MiddlewareListener',
        'ViewJsonRenderer'     => 'Zend\View\Renderer\JsonRenderer',
        'ViewFeedRenderer'     => 'Zend\View\Renderer\FeedRenderer',

        // Pi custom service
        'SendResponseListener' => 'Pi\Mvc\SendResponseListener',
        'ViewHelperManager'    => 'Pi\Mvc\Service\ViewHelperManager',
        'Config'               => 'Pi\Mvc\Service\Config',
        'ErrorStrategy'        => 'Pi\Mvc\View\Http\ErrorStrategy',
        'ViewStrategyListener' => 'Pi\Mvc\View\Http\ViewStrategyListener',
        'FeedStrategyListener' => 'Pi\Mvc\View\Http\FeedStrategyListener',
        'ApiStrategyListener'  => 'Pi\Mvc\View\Http\ApiStrategyListener',
    ],
    'factories'          => [
        'Application'                                => ApplicationFactory::class,
        //'config'                                   => 'Zend\Mvc\Service\ConfigFactory',
        'ControllerManager'                          => 'Zend\Mvc\Service\ControllerManagerFactory',
        //'ControllerPluginManager'                  => 'Zend\Mvc\Service\ControllerPluginManagerFactory',
        'ConsoleAdapter'                             => 'Zend\Mvc\Service\ConsoleAdapterFactory',
        'ConsoleExceptionStrategy'                   => ConsoleExceptionStrategyFactory::class,
        'ConsoleRouter'                              => ConsoleRouterFactory::class,
        'ConsoleRouteNotFoundStrategy'               => ConsoleRouteNotFoundStrategyFactory::class,
        'ConsoleViewManager'                         => 'Zend\Mvc\Service\ConsoleViewManagerFactory',
        'DependencyInjector'                         => DiFactory::class,
        'DiAbstractServiceFactory'                   => DiAbstractServiceFactoryFactory::class,
        'DiServiceInitializer'                       => DiServiceInitializerFactory::class,
        'DiStrictAbstractServiceFactory'             => DiStrictAbstractServiceFactoryFactory::class,
        'DispatchListener'                           => 'Zend\Mvc\Service\DispatchListenerFactory',
        'FilterManager'                              => 'Zend\Mvc\Service\FilterManagerFactory',
        'FormAnnotationBuilder'                      => 'Zend\Mvc\Service\FormAnnotationBuilderFactory',
        'FormElementManager'                         => 'Zend\Mvc\Service\FormElementManagerFactory',
        'HttpExceptionStrategy'                      => HttpExceptionStrategyFactory::class,
        'HttpMethodListener'                         => 'Zend\Mvc\Service\HttpMethodListenerFactory',
        'HttpRouteNotFoundStrategy'                  => HttpRouteNotFoundStrategyFactory::class,
        'HttpRouter'                                 => HttpRouterFactory::class,
        'HttpViewManager'                            => 'Zend\Mvc\Service\HttpViewManagerFactory',
        'HydratorManager'                            => 'Zend\Mvc\Service\HydratorManagerFactory',
        'InjectTemplateListener'                     => 'Zend\Mvc\Service\InjectTemplateListenerFactory',
        'InputFilterManager'                         => 'Zend\Mvc\Service\InputFilterManagerFactory',
        'LogProcessorManager'                        => 'Zend\Mvc\Service\LogProcessorManagerFactory',
        'LogWriterManager'                           => 'Zend\Mvc\Service\LogWriterManagerFactory',
        //'MvcTranslator'                            => 'Zend\Mvc\Service\TranslatorServiceFactory',
        'PaginatorPluginManager'                     => 'Zend\Mvc\Service\PaginatorPluginManagerFactory',
        'Request'                                    => 'Zend\Mvc\Service\RequestFactory',
        'Response'                                   => 'Zend\Mvc\Service\ResponseFactory',
        //'Router'                                   => 'Zend\Mvc\Service\RouterFactory',
        'RoutePluginManager'                         => 'Zend\Mvc\Service\RoutePluginManagerFactory',
        'SerializerAdapterManager'                   => 'Zend\Mvc\Service\SerializerAdapterPluginManagerFactory',
        'TranslatorPluginManager'                    => 'Zend\Mvc\Service\TranslatorPluginManagerFactory',
        'ValidatorManager'                           => 'Zend\Mvc\Service\ValidatorManagerFactory',
        View\Console\DefaultRenderingStrategy::class => InvokableFactory::class,
        //'ViewHelperManager'                        => 'Zend\Mvc\Service\ViewHelperManagerFactory',
        View\Http\DefaultRenderingStrategy::class    => HttpDefaultRenderingStrategyFactory::class,
        'ViewFeedStrategy'                           => 'Zend\Mvc\Service\ViewFeedStrategyFactory',
        'ViewJsonStrategy'                           => 'Zend\Mvc\Service\ViewJsonStrategyFactory',
        'ViewManager'                                => 'Zend\Mvc\Service\ViewManagerFactory',
        //'ViewResolver'                             => 'Zend\Mvc\Service\ViewResolverFactory',
        'ViewTemplateMapResolver'                    => 'Zend\Mvc\Service\ViewTemplateMapResolverFactory',
        'ViewTemplatePathStack'                      => 'Zend\Mvc\Service\ViewTemplatePathStackFactory',
        'ViewPrefixPathStackResolver'                => 'Zend\Mvc\Service\ViewPrefixPathStackResolverFactory',
        'Zend\Mvc\MiddlewareListener'                => InvokableFactory::class,
        'Zend\Mvc\RouteListener'                     => InvokableFactory::class,
        'Zend\Mvc\SendResponseListener'              => InvokableFactory::class,
        'Zend\View\Renderer\FeedRenderer'            => InvokableFactory::class,
        'Zend\View\Renderer\JsonRenderer'            => InvokableFactory::class,
        'Zend\View\Renderer\PhpRenderer'             => ViewPhpRendererFactory::class,
        'Zend\View\Strategy\PhpRendererStrategy'     => ViewPhpRendererStrategyFactory::class,
        'Zend\View\View'                             => ViewFactory::class,

        // Pi custom service
        'Application'                                => 'Pi\Mvc\Service\ApplicationFactory',
        'ControllerLoader'                           => 'Pi\Mvc\Service\ControllerLoaderFactory',
        'ControllerPluginManager'                    => 'Pi\Mvc\Service\ControllerPluginManagerFactory',
        'MvcTranslator'                              => 'Pi\Mvc\Service\TranslatorServiceFactory',
        'ViewResolver'                               => 'Pi\Mvc\Service\ViewResolverFactory',
    ],
    'abstract_factories' => [
        'Zend\Form\FormAbstractServiceFactory',
    ],
];


return [
    // ServiceMananger configuration
    'service_manager'    => $defaultServiceConfig,
    /* 'service_manager'    => [
        // Services that can be instantiated without factories
        'invokables' => [
            'SharedEventManager'   => 'Zend\EventManager\SharedEventManager',

            // From ServiceListenerFactory
            'DispatchListener'     => 'Zend\Mvc\DispatchListener',
            'RouteListener'        => 'Zend\Mvc\RouteListener',
            //'SendResponseListener'      => 'Zend\Mvc\SendResponseListener',
            'ViewJsonRenderer'     => 'Zend\View\Renderer\JsonRenderer',
            'ViewFeedRenderer'     => 'Zend\View\Renderer\FeedRenderer',

            // Pi custom service
            'SendResponseListener' => 'Pi\Mvc\SendResponseListener',
            'ViewHelperManager'    => 'Pi\Mvc\Service\ViewHelperManager',
            'Config'               => 'Pi\Mvc\Service\Config',
            'ErrorStrategy'        => 'Pi\Mvc\View\Http\ErrorStrategy',
            'ViewStrategyListener' => 'Pi\Mvc\View\Http\ViewStrategyListener',
            'FeedStrategyListener' => 'Pi\Mvc\View\Http\FeedStrategyListener',
            'ApiStrategyListener'  => 'Pi\Mvc\View\Http\ApiStrategyListener',
        ],

        // Service factories
        'factories'  => [
            'EventManager'                   => 'Zend\Mvc\Service\EventManagerFactory',
            'ModuleManager'                  => 'Zend\Mvc\Service\ModuleManagerFactory',

            // From ServiceListenerFactory
            'Application'                    => 'Zend\Mvc\Service\ApplicationFactory',
            //'Config'                         => 'Zend\Mvc\Service\ConfigFactory',
            //'ControllerLoader'               => 'Zend\Mvc\Service\ControllerLoaderFactory',
            //'ControllerPluginManager'        => 'Zend\Mvc\Service\ControllerPluginManagerFactory',
            'ConsoleAdapter'                 => 'Zend\Mvc\Service\ConsoleAdapterFactory',
            'ConsoleRouter'                  => 'Zend\Mvc\Service\RouterFactory',
            'ConsoleViewManager'             => 'Zend\Mvc\Service\ConsoleViewManagerFactory',
            'DependencyInjector'             => 'Zend\Mvc\Service\DiFactory',
            'DiAbstractServiceFactory'       => 'Zend\Mvc\Service\DiAbstractServiceFactoryFactory',
            'DiServiceInitializer'           => 'Zend\Mvc\Service\DiServiceInitializerFactory',
            'DiStrictAbstractServiceFactory' => 'Zend\Mvc\Service\DiStrictAbstractServiceFactoryFactory',
            'FilterManager'                  => 'Zend\Mvc\Service\FilterManagerFactory',
            'FormAnnotationBuilder'          => 'Zend\Mvc\Service\FormAnnotationBuilderFactory',
            'FormElementManager'             => 'Zend\Mvc\Service\FormElementManagerFactory',
            'HttpRouter'                     => 'Zend\Mvc\Service\RouterFactory',
            'HttpMethodListener'             => 'Zend\Mvc\Service\HttpMethodListenerFactory',
            'HttpViewManager'                => 'Zend\Mvc\Service\HttpViewManagerFactory',
            'HydratorManager'                => 'Zend\Mvc\Service\HydratorManagerFactory',
            'InjectTemplateListener'         => 'Zend\Mvc\Service\InjectTemplateListenerFactory',
            'InputFilterManager'             => 'Zend\Mvc\Service\InputFilterManagerFactory',
            'LogProcessorManager'            => 'Zend\Mvc\Service\LogProcessorManagerFactory',
            'LogWriterManager'               => 'Zend\Mvc\Service\LogWriterManagerFactory',
            //'MvcTranslator'                  => 'Zend\Mvc\Service\TranslatorServiceFactory',
            'PaginatorPluginManager'         => 'Zend\Mvc\Service\PaginatorPluginManagerFactory',
            'Request'                        => 'Zend\Mvc\Service\RequestFactory',
            'Response'                       => 'Zend\Mvc\Service\ResponseFactory',
            //'Router'                         => 'Zend\Mvc\Service\RouterFactory',
            'RoutePluginManager'             => 'Zend\Mvc\Service\RoutePluginManagerFactory',
            'SerializerAdapterManager'       => 'Zend\Mvc\Service\SerializerAdapterPluginManagerFactory',
            'TranslatorPluginManager'        => 'Zend\Mvc\Service\TranslatorPluginManagerFactory',
            'ValidatorManager'               => 'Zend\Mvc\Service\ValidatorManagerFactory',
            //'ViewHelperManager'              => 'Zend\Mvc\Service\ViewHelperManagerFactory',
            'ViewFeedStrategy'               => 'Zend\Mvc\Service\ViewFeedStrategyFactory',
            'ViewJsonStrategy'               => 'Zend\Mvc\Service\ViewJsonStrategyFactory',
            'ViewManager'                    => 'Zend\Mvc\Service\ViewManagerFactory',
            'ViewResolver'                   => 'Zend\Mvc\Service\ViewResolverFactory',
            'ViewTemplateMapResolver'        => 'Zend\Mvc\Service\ViewTemplateMapResolverFactory',
            'ViewTemplatePathStack'          => 'Zend\Mvc\Service\ViewTemplatePathStackFactory',
            'ViewPrefixPathStackResolver'    => 'Zend\Mvc\Service\ViewPrefixPathStackResolverFactory',

            // Pi custom service
            'Application'                    => 'Pi\Mvc\Service\ApplicationFactory',
            'ControllerLoader'               => 'Pi\Mvc\Service\ControllerLoaderFactory',
            'ControllerPluginManager'        => 'Pi\Mvc\Service\ControllerPluginManagerFactory',
            'MvcTranslator'                  => 'Pi\Mvc\Service\TranslatorServiceFactory',
            'ViewResolver'                   => 'Pi\Mvc\Service\ViewResolverFactory',
        ],

        // Aliases
        'aliases'    => [
            'Zend\EventManager\EventManagerInterface'    => 'EventManager',
            'Zend\Mvc\View\Http\InjectTemplateListener'  => 'InjectTemplateListener',

            // From ServiceListenerFactory
            'Configuration'                              => 'Config',
            'Console'                                    => 'ConsoleAdapter',
            'Di'                                         => 'DependencyInjector',
            'Zend\Di\LocatorInterface'                   => 'DependencyInjector',
            'Zend\Form\Annotation\FormAnnotationBuilder' => 'FormAnnotationBuilder',
            'Zend\Mvc\Controller\PluginManager'          => 'ControllerPluginManager',
            'Zend\Mvc\View\Http\InjectTemplateListener'  => 'InjectTemplateListener',
            'Zend\View\Resolver\TemplateMapResolver'     => 'ViewTemplateMapResolver',
            'Zend\View\Resolver\TemplatePathStack'       => 'ViewTemplatePathStack',
            'Zend\View\Resolver\AggregateResolver'       => 'ViewResolver',
            'Zend\View\Resolver\ResolverInterface'       => 'ViewResolver',
            'ControllerManager'                          => 'ControllerLoader',
        ],

    ], */

    // Listeners to be registered on Application::bootstrap
    'listeners'          => [
        'ViewStrategyListener',
    ],

    // ViewManager configuration
    'view_manager'       => [
        'display_not_found_reason' => true,
        'display_exceptions'       => true,
        'not_found_template'       => 'error-404',
        'exception_template'       => 'error',
        'error_template'           => 'error',
        'denied_template'          => 'error-denied',
        'layout'                   => 'layout-front',
        'layout_error'             => 'layout-simple',
        'layout_ajax'              => 'layout-content',

        'mvc_strategies' => [
            'ErrorStrategy',
        ],

        'strategies' => [
            'ViewJsonStrategy',
        ],
    ],

    // ViewHelper config placeholder
    'view_helper_config' => [],

    // Response sender config
    'send_response'      => [
        // Compression for response
        // By enabling response compression, bandwidth and response time can be decreased but CPU utilization will be increased
        // If compress is needed, it is highly recommended to enable it through web server
        // Or enable `zlib.output_compression` in php.ini
        // @see https://gist.github.com/taiwen/c077ba2c8a33356d8815 for instruction

        // Just in case compression is not enabled by web server or by PHP, specify following specs
        // @note PHP `zlib` extension is required
        'compress' => false,
    ],
];