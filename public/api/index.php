<?php
declare(strict_types=1);

/**
 * EasyRanked :: API REST (comptes, progression, Gunsmith, classement).
 * Le temps reel passe par le WebSocket (server/server.php), pas par ici.
 */

require_once __DIR__ . '/../../server/bootstrap.php';

use EasyRanked\Auth;
use EasyRanked\Config;
use EasyRanked\Database;
use EasyRanked\Progression;

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    header('Allow: GET, POST, OPTIONS');
    http_response_code(204);
    exit;
}

function body(): array
{
    static $cache = null;
    if ($cache !== null) {
        return $cache;
    }
    $raw = file_get_contents('php://input') ?: '';
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        $data = $_POST;
    }
    return $cache = $data;
}

function bearer(): string
{
    $hdr = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
    if (stripos($hdr, 'bearer ') === 0) {
        return trim(substr($hdr, 7));
    }
    return (string) (body()['token'] ?? $_GET['token'] ?? '');
}

function requireUser(): array
{
    $user = Auth::userByToken(bearer());
    if ($user === null) {
        send(['error' => 'Session expiree, reconnecte-toi.'], 401);
    }
    return $user;
}

function send(array $payload, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

/**
 * La route peut arriver de deux facons :
 *   - api/index.php?r=login     -> fonctionne partout, sans reecriture d'URL
 *   - /api/login                -> necessite mod_rewrite (cf. public/.htaccess)
 * Le client utilise la premiere forme : beaucoup d'hebergements mutualises
 * servent PHP derriere nginx, ou .htaccess est purement et simplement ignore.
 */
$route = (string) ($_GET['r'] ?? '');
if ($route === '') {
    $path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
    $route = preg_replace('#^.*?/api#', '', $path) ?? '';
}
$route = trim($route, '/');
if ($route === 'index.php' || str_ends_with($route, '/index.php')) {
    $route = '';          // appel direct du script, sans parametre de route
}
$route = preg_replace('#[^a-z0-9_\-]#i', '', $route) ?? '';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

try {
    switch ("{$method} {$route}") {
        case 'POST register':
            send(Auth::register((string) (body()['username'] ?? ''), (string) (body()['password'] ?? '')));

        case 'POST login':
            send(Auth::login((string) (body()['username'] ?? ''), (string) (body()['password'] ?? '')));

        case 'POST logout':
            Auth::logout(bearer());
            send(['ok' => true]);

        case 'GET me':
            send(['user' => Auth::profile(requireUser()['id'])]);

        case 'GET loadouts':
            send(['loadouts' => Auth::loadouts(requireUser()['id'])]);

        case 'POST loadout':
            $u = requireUser();
            $slot = (int) (body()['slot'] ?? 0);
            $saved = Auth::saveLoadout($u['id'], $slot, [
                'name'        => body()['name'] ?? 'Classe',
                'weapon'      => body()['weapon'] ?? 'mk18',
                'camo'        => body()['camo'] ?? 'default',
                'attachments' => is_array(body()['attachments'] ?? null) ? body()['attachments'] : [],
            ]);
            $level = (int) Progression::fetch($u['id'])['level'];
            send([
                'loadout' => $saved,
                'stats'   => Config::resolveWeapon($saved['weapon'], $saved['attachments']),
                'level'   => $level,
            ]);

        case 'GET config':
            send([
                'weapons' => Config::weapons(),
                'tickRate' => (int) (getenv('ER_TICKRATE') ?: 40),
            ]);

        case 'GET arena':
            send(Config::arena());

        case 'GET leaderboard':
            $st = Database::pdo()->query(
                'SELECT u.username, p.level, p.kills, p.deaths, p.matches_won, p.matches_played
                 FROM progression p JOIN users u ON u.id = p.user_id
                 ORDER BY p.xp_total DESC LIMIT 25'
            );
            $rows = [];
            foreach ($st->fetchAll() as $r) {
                $rows[] = [
                    'username' => $r['username'],
                    'level'    => (int) $r['level'],
                    'kills'    => (int) $r['kills'],
                    'deaths'   => (int) $r['deaths'],
                    'kd'       => (int) $r['deaths'] > 0
                        ? round((int) $r['kills'] / (int) $r['deaths'], 2)
                        : (float) (int) $r['kills'],
                    'wins'     => (int) $r['matches_won'],
                    'matches'  => (int) $r['matches_played'],
                ];
            }
            send(['leaderboard' => $rows]);

        default:
            send(['error' => "Route inconnue: {$method} /{$route}"], 404);
    }
} catch (\InvalidArgumentException $e) {
    send(['error' => $e->getMessage()], 422);
} catch (\RuntimeException $e) {
    // Erreurs de deploiement (droits sur data/, shared/ absent) : le message est
    // actionnable et ne divulgue rien de sensible, on le renvoie tel quel.
    error_log('[api] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    send(['error' => $e->getMessage()], 500);
} catch (\Throwable $e) {
    error_log('[api] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    send(['error' => 'Erreur serveur interne.'], 500);
}
