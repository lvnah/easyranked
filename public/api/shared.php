<?php
declare(strict_types=1);

/** Sert shared/arena.json et shared/weapons.json (dossier hors document root). */
$allowed = ['arena', 'weapons'];
$f = (string) ($_GET['f'] ?? '');
if (!in_array($f, $allowed, true)) {
    http_response_code(404);
    header('Content-Type: application/json');
    echo '{"error":"not found"}';
    exit;
}
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: public, max-age=60');
readfile(dirname(__DIR__, 2) . '/shared/' . $f . '.json');
