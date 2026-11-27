<?php
declare(strict_types=1);

/**
 * EasyRanked :: serveur WebSocket temps reel.
 *
 *   composer install
 *   php server/server.php [--port=8081] [--tick=40] [--host=0.0.0.0]
 */

require __DIR__ . '/bootstrap.php';

use EasyRanked\Database;
use EasyRanked\GameServer;
use Ratchet\Http\HttpServer;
use Ratchet\Server\IoServer;
use Ratchet\WebSocket\WsServer;
use React\EventLoop\Loop;
use React\Socket\SocketServer;

if (PHP_SAPI !== 'cli') {
    exit("A lancer en ligne de commande.\n");
}
if (!class_exists(IoServer::class)) {
    fwrite(STDERR, "Dependances manquantes. Lance d'abord :\n  composer install\n");
    exit(1);
}

$opts = getopt('', ['port::', 'host::', 'tick::']);
$port = (int) ($opts['port'] ?? getenv('ER_PORT') ?: 8081);
$host = (string) ($opts['host'] ?? getenv('ER_HOST') ?: '0.0.0.0');
$tick = (int) ($opts['tick'] ?? getenv('ER_TICKRATE') ?: 40);

Database::pdo();                      // cree/migre la base avant d'accepter du trafic

$loop = Loop::get();
$socket = new SocketServer("{$host}:{$port}", [], $loop);
$game = new GameServer($loop, $tick);

$server = new IoServer(
    new HttpServer(new WsServer($game)),
    $socket,
    $loop
);

fwrite(STDOUT, sprintf(
    "EasyRanked :: WebSocket sur ws://%s:%d  (tickrate %d Hz)\n",
    $host === '0.0.0.0' ? 'localhost' : $host,
    $port,
    $tick
));

$stop = static function () use ($loop): void {
    fwrite(STDOUT, "\nArret du serveur...\n");
    $loop->stop();
};
if (\function_exists('pcntl_signal')) {
    pcntl_async_signals(true);
    pcntl_signal(SIGINT, $stop);
    pcntl_signal(SIGTERM, $stop);
}

$server->run();
