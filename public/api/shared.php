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
$file = dirname(__DIR__, 2) . '/shared/' . $f . '.json';
if (!is_file($file)) {
    // Cause la plus frequente : seul le contenu de public/ a ete televerse.
    // shared/ doit etre a cote de public/, pas dedans.
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode([
        'error' => "Configuration introuvable : {$f}.json. Le dossier shared/ doit se trouver "
                 . 'au meme niveau que public/ (televerse tout le projet, puis pointe la racine '
                 . 'du site sur le sous-dossier public/).',
        'expected' => $file,
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: public, max-age=60');
readfile($file);
