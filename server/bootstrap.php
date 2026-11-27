<?php
declare(strict_types=1);

/** Autoload : Composer si installe, sinon autoloader PSR-4 minimal de secours. */

$composer = __DIR__ . '/../vendor/autoload.php';
if (is_file($composer)) {
    require_once $composer;
} else {
    spl_autoload_register(static function (string $class): void {
        if (!str_starts_with($class, 'EasyRanked\\')) {
            return;
        }
        $rel = str_replace('\\', '/', substr($class, strlen('EasyRanked\\')));
        $file = __DIR__ . '/src/' . $rel . '.php';
        if (is_file($file)) {
            require_once $file;
        }
    });
}

date_default_timezone_set('UTC');
mb_internal_encoding('UTF-8');
