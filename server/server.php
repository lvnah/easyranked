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
    // Sans vendor/, le programme s'arrete immediatement : un hebergeur qui le
    // place derriere son frontal HTTP repond alors « connection failure ».
    fwrite(STDERR,
        "Dependances manquantes : vendor/ est absent.\n"
        . "Lance, a la racine du projet :  composer install\n"
        . "(vendor/ n'est pas versionne ; il faut l'installer sur le serveur,\n"
        . " ou le televerser depuis ton poste.)\n"
    );
    exit(1);
}

/**
 * Adresse d'ecoute, par ordre de priorite :
 *   1. --host / --port en ligne de commande ;
 *   2. les variables PORT et IP, imposees par les hebergeurs qui lancent le
 *      programme eux-memes et le placent derriere leur frontal HTTP
 *      (AlwaysData, Heroku, Scalingo, Clever Cloud...). AlwaysData fournit une
 *      adresse IPv6 et exige qu'on ecoute dessus, pas sur 0.0.0.0 ;
 *   3. les variables ER_HOST / ER_PORT, specifiques au projet ;
 *   4. les valeurs par defaut, pour un poste de developpement.
 */
$opts = getopt('', ['port::', 'host::', 'tick::']);
$env = static fn(string ...$names): ?string => array_reduce(
    $names,
    static function (?string $carry, string $name): ?string {
        if ($carry !== null) {
            return $carry;
        }
        $v = getenv($name);
        return ($v === false || $v === '') ? null : $v;
    },
    null
);

$port = (int) ($opts['port'] ?? $env('PORT', 'ER_PORT') ?? 8081);
$host = (string) ($opts['host'] ?? $env('IP', 'ER_HOST') ?? '0.0.0.0');
$tick = (int) ($opts['tick'] ?? $env('ER_TICKRATE') ?? 40);

// Une adresse IPv6 doit etre entre crochets dans une URI (sinon ses deux-points
// sont pris pour le separateur de port).
$listen = (str_contains($host, ':') && !str_starts_with($host, '['))
    ? "[{$host}]"
    : $host;

Database::pdo();                      // cree/migre la base avant d'accepter du trafic

$loop = Loop::get();
try {
    $socket = new SocketServer("{$listen}:{$port}", [], $loop);
} catch (\Throwable $e) {
    fwrite(STDERR, sprintf(
        "Impossible d'ecouter sur %s:%d : %s\n"
        . "Si l'hebergeur impose une adresse, verifie les variables IP et PORT.\n",
        $listen,
        $port,
        $e->getMessage()
    ));
    exit(1);
}
$game = new GameServer($loop, $tick);

$server = new IoServer(
    new HttpServer(new WsServer($game)),
    $socket,
    $loop
);

fwrite(STDOUT, sprintf(
    "EasyRanked :: WebSocket en ecoute sur %s:%d  (tickrate %d Hz)\n",
    $listen === '0.0.0.0' ? 'localhost' : $listen,
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
