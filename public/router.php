<?php
declare(strict_types=1);

/**
 * Routeur pour le serveur de developpement PHP :
 *   php -S 0.0.0.0:8080 -t public public/router.php
 * En production (Apache/nginx) ce fichier est inutile : voir public/.htaccess.
 */

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';

if (str_starts_with($path, '/api')) {
    require __DIR__ . '/api/index.php';
    return true;
}
if ($path === '/' || $path === '') {
    require __DIR__ . '/index.html';
    return true;
}
// /shared/*.json est servi depuis la racine du projet (hors document root).
if (preg_match('#^/shared/([a-z0-9_\-]+\.json)$#i', $path, $m)) {
    $file = dirname(__DIR__) . '/shared/' . $m[1];
    if (is_file($file)) {
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: public, max-age=60');
        readfile($file);
        return true;
    }
    http_response_code(404);
    echo '{"error":"not found"}';
    return true;
}

return false; // fichier statique servi tel quel
