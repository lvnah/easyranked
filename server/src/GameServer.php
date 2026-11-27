<?php
declare(strict_types=1);

namespace EasyRanked;

use Ratchet\ConnectionInterface;
use Ratchet\MessageComponentInterface;
use React\EventLoop\LoopInterface;

/**
 * Composant Ratchet : matchmaking, salles, boucle de tick (30-60 Hz).
 *
 * Protocole (JSON) client -> serveur :
 *   hello    {token?, name?, mode, bots, skill, slot}
 *   input    {seq, pos, vel, yaw, pitch, stance, flags}
 *   shoot    {d, o, lat}
 *   reload   {}
 *   nade     {d}
 *   chat     {msg}
 *   pong     {id}
 *   leave    {}
 */
final class GameServer implements MessageComponentInterface
{
    /** @var \SplObjectStorage<ConnectionInterface,array> */
    private \SplObjectStorage $clients;
    /** @var array<string,Room> */
    private array $rooms = [];
    /** @var array<string,ConnectionInterface> */
    private array $connById = [];
    private int $tick = 0;
    private float $lastTick;
    private int $guestCounter = 0;
    private array $perf = ['max' => 0.0, 'sum' => 0.0, 'n' => 0];

    public function __construct(
        private LoopInterface $loop,
        private int $tickRate = 40
    ) {
        $this->clients = new \SplObjectStorage();
        $this->lastTick = microtime(true);
        $this->tickRate = max(20, min(60, $tickRate));

        $this->loop->addPeriodicTimer(1 / $this->tickRate, function (): void {
            $this->step();
        });
        $this->loop->addPeriodicTimer(15.0, function (): void {
            $this->housekeeping();
        });
    }

    /* ------------------------------------------------------------ Ratchet */

    public function onOpen(ConnectionInterface $conn): void
    {
        $this->clients->attach($conn, ['pid' => null, 'room' => null, 'ping' => 0.0,
                                       'since' => microtime(true), 'rx' => 0]);
        $this->sendTo($conn, ['t' => 'hello', 'tickRate' => $this->tickRate,
                              'balance' => Config::balance()]);
    }

    public function onMessage(ConnectionInterface $from, $msg): void
    {
        $meta = $this->clients[$from] ?? null;
        if ($meta === null) {
            return;
        }
        // Garde-fou : taille des trames et debit.
        if (strlen((string) $msg) > 4096) {
            $this->sendTo($from, ['t' => 'error', 'msg' => 'Trame trop volumineuse.']);
            return;
        }
        $meta['rx']++;
        $this->clients[$from] = $meta;

        $data = json_decode((string) $msg, true);
        if (!is_array($data) || !isset($data['t'])) {
            return;
        }
        $now = microtime(true);

        try {
            switch ($data['t']) {
                case 'hello':
                    $this->handleHello($from, $data, $now);
                    break;

                case 'input':
                case 'shoot':
                case 'reload':
                case 'nade':
                case 'chat':
                case 'leave':
                    $this->handleGameMessage($from, $data, $now);
                    break;

                case 'pong':
                    $meta = $this->clients[$from];
                    $meta['ping'] = ($now - (float) ($data['id'] ?? $now)) * 1000.0;
                    $this->clients[$from] = $meta;
                    break;
            }
        } catch (\Throwable $e) {
            error_log('[ws] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
            $this->sendTo($from, ['t' => 'error', 'msg' => 'Erreur serveur.']);
        }
    }

    public function onClose(ConnectionInterface $conn): void
    {
        $meta = $this->clients[$conn] ?? null;
        if ($meta !== null && $meta['pid'] !== null) {
            $room = $this->rooms[$meta['room']] ?? null;
            if ($room !== null) {
                $room->removePlayer($meta['pid']);
            }
            unset($this->connById[$meta['pid']]);
        }
        $this->clients->detach($conn);
    }

    public function onError(ConnectionInterface $conn, \Exception $e): void
    {
        error_log('[ws] erreur connexion: ' . $e->getMessage());
        $conn->close();
    }

    /* ------------------------------------------------------------ handlers */

    private function handleHello(ConnectionInterface $conn, array $data, float $now): void
    {
        $meta = $this->clients[$conn];
        if ($meta['pid'] !== null) {
            return;                                   // deja authentifie
        }

        $userId = null;
        $level = 1;
        $loadout = ['weapon' => 'mk18', 'camo' => 'default', 'attachments' => []];
        $name = 'Invite' . (++$this->guestCounter);

        $token = (string) ($data['token'] ?? '');
        if ($token !== '') {
            $user = Auth::userByToken($token);
            if ($user === null) {
                $this->sendTo($conn, ['t' => 'error', 'msg' => 'Session invalide.', 'fatal' => true]);
                $conn->close();
                return;
            }
            $userId = $user['id'];
            $name = $user['username'];
            $prog = Progression::fetch($userId);
            $level = (int) $prog['level'];
            $loadout = Auth::loadout($userId, (int) ($data['slot'] ?? 0));
        } elseif (isset($data['name']) && is_string($data['name'])) {
            $clean = preg_replace('/[^A-Za-z0-9_\- ]/', '', trim($data['name'])) ?? '';
            if ($clean !== '') {
                $name = mb_substr($clean, 0, 18);
            }
        }
        // Securite : un invite ne beneficie d'aucun accessoire.
        $loadout = Config::sanitizeLoadout($loadout, $level) + ['name' => $loadout['name'] ?? 'Classe'];

        $mode = (string) ($data['mode'] ?? '2v2');
        if (!isset(Config::weapons()['modes'][$mode])) {
            $mode = '2v2';
        }
        $wantBots = (bool) ($data['bots'] ?? true);
        $skill = max(0.0, min(1.0, (float) ($data['skill'] ?? 0.6)));

        $room = $this->findRoom($mode, $wantBots, $skill);
        $pid = 'p' . substr(bin2hex(random_bytes(5)), 0, 10);
        $player = new PlayerState($pid, $name, $loadout, $level);
        $player->userId = $userId;
        $room->addPlayer($player);

        $meta['pid'] = $pid;
        $meta['room'] = $room->id;
        $this->clients[$conn] = $meta;
        $this->connById[$pid] = $conn;

        $this->sendTo($conn, [
            't'        => 'welcome',
            'you'      => $pid,
            'room'     => $room->id,
            'mode'     => $room->mode,
            'team'     => $player->team,
            'tickRate' => $this->tickRate,
            'state'    => $room->state,
            'roster'   => $room->roster(),
            'stats'    => $player->stats,
            'loadout'  => $loadout,
            'level'    => $level,
            'spawn'    => [round($player->pos[0], 2), 0, round($player->pos[2], 2)],
            'scoreLimit' => Config::mode($room->mode)['scoreLimit'],
        ]);
        error_log("[ws] {$name} -> salle {$room->id} ({$mode}, equipe {$player->team})");
    }

    private function handleGameMessage(ConnectionInterface $conn, array $data, float $now): void
    {
        $meta = $this->clients[$conn];
        if ($meta['pid'] === null) {
            return;
        }
        $room = $this->rooms[$meta['room']] ?? null;
        if ($room === null) {
            return;
        }
        $player = $room->player($meta['pid']);
        if ($player === null) {
            return;
        }

        switch ($data['t']) {
            case 'input':
                $room->applyInput($player, $data, $now);
                break;
            case 'shoot':
                $room->playerShoot($player, $data, $now);
                break;
            case 'reload':
                $room->requestReload($player, $now);
                break;
            case 'nade':
                $room->throwGrenade($player, $data, $now);
                break;
            case 'chat':
                $txt = mb_substr(trim((string) ($data['msg'] ?? '')), 0, 120);
                if ($txt !== '') {
                    $room->push(['t' => 'chat', 'from' => $player->name, 'team' => $player->team, 'msg' => $txt]);
                }
                break;
            case 'leave':
                $room->removePlayer($player->id);
                unset($this->connById[$player->id]);
                $meta['pid'] = null;
                $meta['room'] = null;
                $this->clients[$conn] = $meta;
                $this->sendTo($conn, ['t' => 'left']);
                break;
        }
    }

    /* ---------------------------------------------------------- matchmaking */

    private function findRoom(string $mode, bool $withBots, float $skill): Room
    {
        foreach ($this->rooms as $room) {
            if ($room->mode === $mode && $room->withBots === $withBots && $room->isJoinable()) {
                return $room;
            }
        }
        $id = $mode . '_' . substr(bin2hex(random_bytes(4)), 0, 8);
        $room = new Room($id, $mode, $withBots, $skill);
        $this->rooms[$id] = $room;
        error_log("[ws] nouvelle salle {$id} (bots=" . ($withBots ? 'oui' : 'non') . ')');
        return $room;
    }

    /* ----------------------------------------------------------- boucle */

    private function step(): void
    {
        $now = microtime(true);
        $dt = min(0.25, $now - $this->lastTick);
        $this->lastTick = $now;
        $this->tick++;
        $t0 = $now;

        foreach ($this->rooms as $room) {
            $room->tick($now, $dt);
            $snap = $room->drain($this->tick);
            if ($snap['p'] === [] && $snap['e'] === []) {
                continue;
            }
            $payload = json_encode($snap, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            if ($payload === false) {
                continue;
            }
            foreach ($room->players() as $p) {
                if ($p->isBot) {
                    continue;
                }
                $conn = $this->connById[$p->id] ?? null;
                if ($conn !== null) {
                    $conn->send($payload);
                }
            }
        }

        // Mesure de charge : le tick doit rester tres en dessous du budget.
        $spent = microtime(true) - $t0;
        $this->perf['max'] = max($this->perf['max'], $spent);
        $this->perf['sum'] += $spent;
        $this->perf['n']++;

        if ($this->tick % ($this->tickRate * 2) === 0) {
            $stamp = microtime(true);
            foreach ($this->clients as $conn) {
                $this->sendTo($conn, ['t' => 'ping', 'id' => $stamp]);
            }
        }
    }

    private function housekeeping(): void
    {
        $now = microtime(true);
        foreach ($this->rooms as $id => $room) {
            $empty = $room->humanCount() === 0;
            if ($room->state === Room::OVER || ($empty && $now - $room->startedAt > 20.0)) {
                if ($empty || $now - $room->startedAt > 25.0) {
                    unset($this->rooms[$id]);
                    foreach ($room->players() as $p) {
                        $conn = $this->connById[$p->id] ?? null;
                        if ($conn !== null) {
                            $this->sendTo($conn, ['t' => 'closed']);
                            $meta = $this->clients[$conn] ?? null;
                            if ($meta !== null) {
                                $meta['pid'] = null;
                                $meta['room'] = null;
                                $this->clients[$conn] = $meta;
                            }
                            unset($this->connById[$p->id]);
                        }
                    }
                    error_log("[ws] salle {$id} fermee");
                }
            }
        }
        if ($this->perf['n'] > 0) {
            $avg = ($this->perf['sum'] / $this->perf['n']) * 1000;
            $budget = (1 / $this->tickRate) * 1000;
            error_log(sprintf(
                '[perf] tick moy %.2f ms / max %.2f ms (budget %.1f ms) | salles=%d joueurs=%d',
                $avg,
                $this->perf['max'] * 1000,
                $budget,
                count($this->rooms),
                count($this->connById)
            ));
            $this->perf = ['max' => 0.0, 'sum' => 0.0, 'n' => 0];
        }
    }

    private function sendTo(ConnectionInterface $conn, array $payload): void
    {
        $json = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($json !== false) {
            $conn->send($json);
        }
    }
}
