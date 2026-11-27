<?php
declare(strict_types=1);

namespace EasyRanked;

/**
 * Une salle = une partie (1v1 a 4v4), joueurs et bots melanges.
 * C'est l'autorite : positions validees, tirs valides avec compensation de lag,
 * score, respawns et attribution d'XP.
 */
final class Room
{
    public const WAIT = 'waiting';
    public const LIVE = 'live';
    public const OVER = 'over';

    public string $state = self::WAIT;
    public float $startedAt = 0.0;
    public float $endsAt = 0.0;
    public array $score = [0, 0];
    public ?int $matchId = null;

    /** @var array<string,PlayerState> */
    private array $players = [];
    /** @var list<array> evenements a diffuser au prochain tick */
    private array $events = [];
    private Ballistics $bal;
    private array $modeCfg;
    private int $botCounter = 0;
    private array $spawnUsedAt = [];
    /** @var list<array{at:array,by:string,time:float}> grenades en vol */
    private array $pendingBlasts = [];

    public function __construct(
        public string $id,
        public string $mode,
        public bool $withBots,
        public float $botSkill = 0.6
    ) {
        $this->bal = new Ballistics();
        $this->modeCfg = Config::mode($mode);
    }

    public function ballistics(): Ballistics
    {
        return $this->bal;
    }

    public function teamSize(): int
    {
        return (int) $this->modeCfg['teamSize'];
    }

    public function capacity(): int
    {
        return $this->teamSize() * 2;
    }

    /** @return array<string,PlayerState> */
    public function players(): array
    {
        return $this->players;
    }

    public function player(string $id): ?PlayerState
    {
        return $this->players[$id] ?? null;
    }

    public function humanCount(): int
    {
        $n = 0;
        foreach ($this->players as $p) {
            if (!$p->isBot) {
                $n++;
            }
        }
        return $n;
    }

    public function isJoinable(): bool
    {
        if ($this->state === self::OVER) {
            return false;
        }
        $humans = $this->humanCount();
        return $humans < $this->capacity();
    }

    /* --------------------------------------------------------------- joueurs */

    public function addPlayer(PlayerState $p): void
    {
        $p->team = $this->pickTeam();
        $this->players[$p->id] = $p;
        $p->reset($this->pickSpawn($p->team), $this->now());
        $this->push(['t' => 'join', 'player' => $p->describe()]);
        $this->rebalanceBots();
        $this->maybeStart();
    }

    public function removePlayer(string $id): void
    {
        if (!isset($this->players[$id])) {
            return;
        }
        unset($this->players[$id]);
        $this->push(['t' => 'leave', 'id' => $id]);
        if ($this->state === self::LIVE) {
            $this->rebalanceBots();
        }
    }

    private function pickTeam(): int
    {
        $count = [0, 0];
        foreach ($this->players as $p) {
            if (!$p->isBot) {
                $count[$p->team]++;
            }
        }
        if ($count[0] === $count[1]) {
            return $count[0] >= $this->teamSize() ? 1 : 0;
        }
        return $count[0] < $count[1] ? 0 : 1;
    }

    /** Complete / retire des bots pour que chaque equipe soit au complet. */
    public function rebalanceBots(): void
    {
        if (!$this->withBots) {
            return;
        }
        for ($team = 0; $team <= 1; $team++) {
            $humans = 0;
            $bots = [];
            foreach ($this->players as $p) {
                if ($p->team !== $team) {
                    continue;
                }
                if ($p->isBot) {
                    $bots[] = $p->id;
                } else {
                    $humans++;
                }
            }
            $need = $this->teamSize() - $humans - count($bots);
            while ($need > 0) {
                $this->spawnBot($team);
                $need--;
            }
            while ($need < 0 && $bots !== []) {
                $this->removePlayer((string) array_pop($bots));
                $need++;
            }
        }
    }

    private function spawnBot(int $team): void
    {
        static $names = ['Volkov', 'Reaper', 'Kilo', 'Nomad', 'Wraith', 'Spектр', 'Dusk', 'Ronin',
                         'Falco', 'Mirage', 'Tundra', 'Vega', 'Hawk', 'Zulu', 'Orion', 'Baron'];
        $id = 'bot_' . $this->id . '_' . (++$this->botCounter);
        $name = $names[($this->botCounter - 1) % count($names)];
        $weapons = ['mk18', 'mp5', 'ak74', 'mk18'];
        $loadout = [
            'weapon' => $weapons[random_int(0, 3)],
            'camo'   => ['default', 'woodland', 'urban'][random_int(0, 2)],
            'attachments' => ['optic' => 'reddot', 'muzzle' => 'comp', 'grip' => 'vertical'],
        ];
        $skill = max(0.05, min(1.0, $this->botSkill + (random_int(-14, 14) / 100.0)));
        $bot = new Bot($id, $name, $loadout, $skill, 1 + (int) round($skill * 40));
        $bot->team = $team;
        $this->players[$id] = $bot;
        $bot->reset($this->pickSpawn($team), $this->now());
        $this->push(['t' => 'join', 'player' => $bot->describe()]);
    }

    private function maybeStart(): void
    {
        if ($this->state !== self::WAIT) {
            return;
        }
        $ready = $this->withBots || $this->humanCount() >= $this->capacity();
        if (!$ready) {
            return;
        }
        $this->state = self::LIVE;
        $this->startedAt = $this->now();
        $this->endsAt = $this->startedAt + (float) $this->modeCfg['timeLimit'];
        $this->score = [0, 0];

        try {
            $pdo = Database::pdo();
            $pdo->prepare('INSERT INTO matches (mode, started_at, with_bots) VALUES (?, ?, ?)')
                ->execute([$this->mode, Database::now(), $this->withBots ? 1 : 0]);
            $this->matchId = (int) $pdo->lastInsertId();
        } catch (\Throwable $e) {
            error_log('[room] match insert: ' . $e->getMessage());
        }

        foreach ($this->players as $p) {
            $p->reset($this->pickSpawn($p->team), $this->startedAt);
        }
        $this->push(['t' => 'start', 'mode' => $this->mode, 'endsAt' => $this->endsAt,
                     'scoreLimit' => $this->modeCfg['scoreLimit']]);
    }

    /* ----------------------------------------------------------------- spawn */

    private function pickSpawn(int $team): array
    {
        $arena = Config::arena();
        $candidates = $arena['spawns'][(string) $team] ?? $arena['spawns'][$team] ?? [[0, 0, 0]];
        $now = $this->now();
        $best = $candidates[0];
        $bestScore = -INF;

        foreach ($candidates as $i => $sp) {
            $key = $team . ':' . $i;
            $recent = $now - ($this->spawnUsedAt[$key] ?? -99.0);
            $score = min($recent, 12.0) * 1.2;
            foreach ($this->players as $p) {
                if (!$p->alive) {
                    continue;
                }
                $d = sqrt(($p->pos[0] - $sp[0]) ** 2 + ($p->pos[2] - $sp[2]) ** 2);
                // On s'eloigne des ennemis, on reste pres des allies.
                $score += $p->team === $team ? -max(0.0, 14.0 - $d) * 0.25 : min($d, 40.0) * 0.55;
                if ($p->team !== $team && $d < 12.0) {
                    $score -= 45.0;        // jamais de spawn dans le dos d'un ennemi proche
                }
            }
            $score += random_int(0, 300) / 100.0;
            if ($score > $bestScore) {
                $bestScore = $score;
                $best = $sp;
                $this->spawnUsedAt[$key] = $now;
            }
        }
        return [(float) $best[0], 0.0, (float) $best[2]];
    }

    /* ------------------------------------------------------------------ tick */

    public function tick(float $now, float $dt): void
    {
        if ($this->state === self::WAIT) {
            $this->maybeStart();
            return;
        }
        if ($this->state === self::OVER) {
            return;
        }

        foreach ($this->players as $p) {
            $p->record($now);

            if ($p->reloading && $now >= $p->reloadDoneAt) {
                $need = (int) $p->stats['magazine'] - $p->ammo;
                $take = min($need, $p->reserve);
                $p->ammo += $take;
                $p->reserve -= $take;
                $p->reloading = false;
            }
            if (!$p->alive && $now >= $p->respawnAt) {
                $p->reset($this->pickSpawn($p->team), $now);
                $this->push(['t' => 'spawn', 'id' => $p->id,
                             'pos' => [round($p->pos[0], 2), 0, round($p->pos[2], 2)]]);
            }
            $p->regen($now, $dt);

            if ($p instanceof Bot) {
                $p->tick($now, $dt, $this);
            }
        }

        $this->resolveBlasts($now);

        $limit = (int) $this->modeCfg['scoreLimit'];
        if ($this->score[0] >= $limit || $this->score[1] >= $limit || $now >= $this->endsAt) {
            $this->finish($now);
        }
    }

    /* ----------------------------------------------------------------- input */

    /** Applique une trame d'input client, avec controles anti-triche. */
    public function applyInput(PlayerState $p, array $msg, float $now): void
    {
        $seq = (int) ($msg['seq'] ?? 0);
        if ($seq <= $p->lastInputSeq && $p->lastInputSeq - $seq < 1000) {
            return;                                  // trame perimee ou rejouee
        }
        $pos = $msg['pos'] ?? null;
        if (!is_array($pos) || count($pos) < 3) {
            return;
        }
        $nx = (float) $pos[0];
        $ny = (float) $pos[1];
        $nz = (float) $pos[2];
        if (!is_finite($nx) || !is_finite($ny) || !is_finite($nz)) {
            return;
        }

        $bounds = Config::arena()['bounds'];
        $nx = max(-$bounds['w'] / 2 + 0.4, min($bounds['w'] / 2 - 0.4, $nx));
        $nz = max(-$bounds['d'] / 2 + 0.4, min($bounds['d'] / 2 - 0.4, $nz));
        $ny = max(0.0, min((float) $bounds['wallH'] + 4.0, $ny));

        // Controle de vitesse : on tolere 1.9x la vitesse max theorique (gigue reseau,
        // glissade, saut en devers), au-dela on recale le joueur sur sa derniere position.
        $dtIn = max(0.016, min(0.5, $now - ($p->lastInputAt ?: $now - 0.05)));
        $moved = sqrt(($nx - $p->pos[0]) ** 2 + ($nz - $p->pos[2]) ** 2);
        $maxStep = 11.5 * $p->stats['mobility'] * $dtIn * 1.9 + 0.35;
        if ($moved > $maxStep && $p->lastInputAt > 0.0) {
            $p->warnings++;
            if ($p->warnings % 12 === 1) {
                error_log(sprintf('[anticheat] %s: deplacement %.2fm > %.2fm', $p->name, $moved, $maxStep));
            }
            // Correction limitee a 5 Hz : un client desynchronise (respawn ignore,
            // perte de paquets) ne doit pas generer une trame de recalage par input.
            if ($now - $p->lastCorrectionAt > 0.2) {
                $p->lastCorrectionAt = $now;
                $this->push(['t' => 'correct', 'id' => $p->id,
                             'pos' => [round($p->pos[0], 2), round($p->pos[1], 2), round($p->pos[2], 2)]]);
            }
        } else {
            $p->pos = [$nx, $ny, $nz];
        }

        $p->yaw = (float) ($msg['yaw'] ?? $p->yaw);
        $p->pitch = max(-1.55, min(1.55, (float) ($msg['pitch'] ?? $p->pitch)));
        $p->stance = max(0.55, min(1.0, (float) ($msg['stance'] ?? 1.0)));
        $flags = (int) ($msg['flags'] ?? 0);
        $p->sprinting = (bool) ($flags & 1);
        $p->ads = (bool) ($flags & 2);
        $p->sliding = (bool) ($flags & 4);
        $p->grounded = (bool) ($flags & 8);
        if (is_array($msg['vel'] ?? null) && count($msg['vel']) >= 3) {
            $p->vel = [(float) $msg['vel'][0], (float) $msg['vel'][1], (float) $msg['vel'][2]];
        }
        $p->lastInputSeq = $seq;
        $p->lastInputAt = $now;
    }

    public function requestReload(PlayerState $p, float $now): void
    {
        if ($p->reloading || !$p->alive || $p->reserve <= 0
            || $p->ammo >= (int) $p->stats['magazine']) {
            return;
        }
        $p->reloading = true;
        $p->reloadDoneAt = $now + ($p->ammo === 0
            ? $p->stats['reloadEmptyTime']
            : $p->stats['reloadTime']);
        $this->push(['t' => 'reload', 'id' => $p->id, 'done' => round($p->reloadDoneAt - $now, 2)]);
    }

    /* ------------------------------------------------------------------ tirs */

    /**
     * Tir d'un joueur humain. L'origine annoncee par le client est verifiee
     * contre la position connue du serveur ; la cible est rembobinee dans le temps.
     */
    public function playerShoot(PlayerState $p, array $msg, float $now): void
    {
        if (!$p->alive || $this->state !== self::LIVE) {
            return;
        }
        if ($p->reloading || $now < $p->nextShotAt) {
            return;
        }
        if ($p->ammo <= 0) {
            $this->requestReload($p, $now);
            return;
        }
        $dir = Ballistics::normalize($msg['d'] ?? [0, 0, 1]);
        $eye = $p->eye();

        // L'origine vient toujours du serveur : un client ne peut pas tirer d'ailleurs.
        $claimed = $msg['o'] ?? null;
        if (is_array($claimed) && count($claimed) >= 3) {
            $drift = sqrt(((float) $claimed[0] - $eye[0]) ** 2
                        + ((float) $claimed[1] - $eye[1]) ** 2
                        + ((float) $claimed[2] - $eye[2]) ** 2);
            if ($drift > 2.5) {
                $p->warnings++;
            }
        }

        $p->ammo--;
        $p->nextShotAt = $now + $p->stats['fireInterval'] * 0.94;   // marge de gigue
        $p->lastShotAt = $now;
        $p->shotsInBurst++;

        // Rembobinage : on evalue les cibles telles que le tireur les voyait.
        $rewind = $this->rewindTime($p, $msg, $now);
        $this->resolveShot($p, $eye, $dir, $rewind, $now, false);
    }

    public function botShoot(Bot $bot, array $dir, float $now): void
    {
        if ($bot->ammo <= 0) {
            return;
        }
        $bot->ammo--;
        $bot->nextShotAt = $now + $bot->stats['fireInterval'];
        $bot->lastShotAt = $now;

        // Dispersion : le bot ne touche pas parfaitement, meme bien aligne.
        $spread = deg2rad($bot->spreadDegrees()) * 0.5;
        $dir = self::jitterDirection($dir, $spread);
        $this->resolveShot($bot, $bot->eye(), $dir, $now, $now, true);
    }

    /** Instant de rembobinage valide (borne par la fenetre d'historique). */
    private function rewindTime(PlayerState $p, array $msg, float $now): float
    {
        $lat = (float) ($msg['lat'] ?? 0.0);
        $lat = max(0.0, min(0.25, $lat / 1000.0));     // 250 ms maxi de compensation
        return $now - $lat;
    }

    /** Lancer de rayon commun joueurs/bots. */
    private function resolveShot(
        PlayerState $shooter,
        array $eye,
        array $dir,
        float $rewindAt,
        float $now,
        bool $isBot
    ): void {
        $maxDist = 240.0;
        $wall = $this->bal->rayWorld($eye, $dir, $maxDist);
        $limit = $wall === INF ? $maxDist : $wall;

        $hit = null;
        foreach ($this->players as $target) {
            if ($target->id === $shooter->id || $target->team === $shooter->team || !$target->alive) {
                continue;
            }
            $snap = $target->at($rewindAt);
            $res = Ballistics::rayPlayer($eye, $dir, $snap['pos'], $snap['stance'], $limit);
            if ($res === null) {
                continue;
            }
            if ($hit === null || $res['dist'] < $hit['dist']) {
                $hit = $res + ['target' => $target];
            }
        }

        $impact = [
            round($eye[0] + $dir[0] * ($hit['dist'] ?? $limit), 2),
            round($eye[1] + $dir[1] * ($hit['dist'] ?? $limit), 2),
            round($eye[2] + $dir[2] * ($hit['dist'] ?? $limit), 2),
        ];
        $this->push([
            't' => 'shot', 'id' => $shooter->id,
            'o' => [round($eye[0], 2), round($eye[1], 2), round($eye[2], 2)],
            'p' => $impact,
            'hit' => $hit !== null ? 1 : 0,
            'silent' => $shooter->stats['silent'] ? 1 : 0,
        ]);

        if ($hit === null) {
            return;
        }

        /** @var PlayerState $target */
        $target = $hit['target'];
        $dmg = Ballistics::damageAtRange($shooter->stats, $hit['dist']) * $hit['mul'];
        $res = $target->takeDamage($dmg, $shooter->id, $now);
        if ($res['applied'] <= 0.0) {
            return;
        }
        $shooter->damageDealt += $res['applied'];

        $this->push([
            't' => 'dmg', 'by' => $shooter->id, 'on' => $target->id,
            'zone' => $hit['zone'], 'amount' => round($res['applied'], 1),
            'hp' => (int) round($target->health), 'kill' => $res['killed'] ? 1 : 0,
            'pos' => [round($target->pos[0], 2), round($target->pos[1] + 1.2, 2), round($target->pos[2], 2)],
        ]);

        if ($res['killed']) {
            $this->onKill($shooter, $target, $hit['zone'] === 'head', $now);
        }
    }

    /* --------------------------------------------------------------- grenades */

    public function throwGrenade(PlayerState $p, array $msg, float $now): void
    {
        if (!$p->alive || $p->grenades <= 0 || $this->state !== self::LIVE) {
            return;
        }
        $p->grenades--;
        $g = Config::weapons()['grenades'];
        $dir = Ballistics::normalize($msg['d'] ?? [0, 0, 1]);
        $origin = $p->eye();

        // Simulation balistique deterministe (le client rejoue la meme trajectoire).
        $vel = [$dir[0] * $g['throwSpeed'], $dir[1] * $g['throwSpeed'] + 2.0, $dir[2] * $g['throwSpeed']];
        $pos = $origin;
        $step = 1 / 60;
        $fuse = (float) $g['fuse'];
        for ($t = 0.0; $t < $fuse; $t += $step) {
            $next = [
                $pos[0] + $vel[0] * $step,
                $pos[1] + $vel[1] * $step,
                $pos[2] + $vel[2] * $step,
            ];
            $vel[1] -= 19.6 * $step;
            if ($next[1] <= 0.08) {
                $next[1] = 0.08;
                $vel = [$vel[0] * 0.42, abs($vel[1]) * 0.26, $vel[2] * 0.42];
                if (abs($vel[1]) < 0.9) {
                    $vel[1] = 0.0;
                }
            }
            // Rebond sur les murs : on teste le segment contre le monde.
            $seg = [$next[0] - $pos[0], $next[1] - $pos[1], $next[2] - $pos[2]];
            $segLen = sqrt($seg[0] ** 2 + $seg[1] ** 2 + $seg[2] ** 2);
            if ($segLen > 1e-5) {
                $d = [$seg[0] / $segLen, $seg[1] / $segLen, $seg[2] / $segLen];
                if ($this->bal->rayWorld($pos, $d, $segLen + 0.12) !== INF) {
                    $vel = [-$vel[0] * 0.38, $vel[1] * 0.5, -$vel[2] * 0.38];
                    $next = $pos;
                }
            }
            $pos = $next;
        }

        $this->push([
            't' => 'nade', 'by' => $p->id,
            'o' => [round($origin[0], 2), round($origin[1], 2), round($origin[2], 2)],
            'd' => [round($dir[0], 3), round($dir[1], 3), round($dir[2], 3)],
            'at' => [round($pos[0], 2), round($pos[1], 2), round($pos[2], 2)],
            'fuse' => $fuse,
            'left' => $p->grenades,
        ]);

        // L'explosion est resolue a la fin de la meche.
        $this->pendingBlasts[] = ['at' => $pos, 'by' => $p->id, 'time' => $now + $fuse];
    }

    public function resolveBlasts(float $now): void
    {
        if ($this->pendingBlasts === []) {
            return;
        }
        $g = Config::weapons()['grenades'];
        $remaining = [];
        foreach ($this->pendingBlasts as $blast) {
            if ($now < $blast['time']) {
                $remaining[] = $blast;
                continue;
            }
            $src = $this->players[$blast['by']] ?? null;
            $center = [$blast['at'][0], $blast['at'][1] + 0.25, $blast['at'][2]];
            $this->push(['t' => 'blast', 'at' => [round($center[0], 2), round($center[1], 2), round($center[2], 2)]]);

            foreach ($this->players as $target) {
                if (!$target->alive) {
                    continue;
                }
                $chest = [$target->pos[0], $target->pos[1] + 1.1 * $target->stance, $target->pos[2]];
                $dist = sqrt(($chest[0] - $center[0]) ** 2 + ($chest[1] - $center[1]) ** 2
                           + ($chest[2] - $center[2]) ** 2);
                if ($dist > $g['radius']) {
                    continue;
                }
                if (!$this->bal->lineOfSight($center, $chest)) {
                    continue;                         // un mur protege de l'explosion
                }
                $falloff = 1.0 - ($dist / $g['radius']) ** 1.45;
                $dmg = $g['damage'] * max(0.0, $falloff);
                $friendly = $src !== null && $src->team === $target->team && $src->id !== $target->id;
                if ($friendly) {
                    continue;                         // pas de tir ami
                }
                $res = $target->takeDamage($dmg, $blast['by'], $now);
                if ($res['applied'] <= 0) {
                    continue;
                }
                if ($src !== null && $src->id !== $target->id) {
                    $src->damageDealt += $res['applied'];
                }
                $this->push(['t' => 'dmg', 'by' => $blast['by'], 'on' => $target->id,
                             'zone' => 'blast', 'amount' => round($res['applied'], 1),
                             'hp' => (int) round($target->health), 'kill' => $res['killed'] ? 1 : 0,
                             'pos' => [round($chest[0], 2), round($chest[1], 2), round($chest[2], 2)]]);
                if ($res['killed'] && $src !== null) {
                    $this->onKill($src, $target, false, $now);
                }
            }
        }
        $this->pendingBlasts = $remaining;
    }

    /* ------------------------------------------------------------------ kills */

    private function onKill(PlayerState $killer, PlayerState $victim, bool $headshot, float $now): void
    {
        $suicide = $killer->id === $victim->id;
        $xpCfg = Config::weapons()['xp'];

        if (!$suicide) {
            $killer->addKill($headshot);
            $this->score[$killer->team]++;
            $killer->xpEarned += (int) $xpCfg['kill'] + ($headshot ? (int) $xpCfg['headshot'] : 0);
        } else {
            $this->score[1 - $victim->team]++;
        }

        // Assistances : tout coequipier ayant inflige >= 30 PV a la victime.
        $assists = [];
        foreach ($victim->damageFrom as $byId => $amount) {
            if ($byId === $killer->id || $amount < 30.0) {
                continue;
            }
            $helper = $this->players[$byId] ?? null;
            if ($helper === null || $helper->team === $victim->team) {
                continue;
            }
            $helper->assists++;
            $helper->xpEarned += (int) $xpCfg['assist'];
            $assists[] = $helper->id;
        }

        $this->push([
            't' => 'kill',
            'by' => $killer->id, 'on' => $victim->id,
            'headshot' => $headshot ? 1 : 0,
            'assists' => $assists,
            'streak' => $killer->streak,
            'score' => $this->score,
            'respawnIn' => round($victim->respawnAt - $now, 2),
        ]);
    }

    /* ------------------------------------------------------------------- fin */

    private function finish(float $now): void
    {
        $this->state = self::OVER;
        $winner = $this->score[0] === $this->score[1] ? -1 : ($this->score[0] > $this->score[1] ? 0 : 1);
        $duration = max(1, (int) round($now - $this->startedAt));
        $xpCfg = Config::weapons()['xp'];
        $summary = [];

        foreach ($this->players as $p) {
            $won = $winner === $p->team;
            $p->xpEarned += (int) round($p->damageDealt * $xpCfg['perDamage']);
            $p->xpEarned += $won ? (int) $xpCfg['win'] : (int) $xpCfg['loss'];

            $entry = [
                'id' => $p->id, 'name' => $p->name, 'team' => $p->team, 'bot' => $p->isBot,
                'kills' => $p->kills, 'deaths' => $p->deaths, 'assists' => $p->assists,
                'damage' => (int) round($p->damageDealt), 'headshots' => $p->headshots,
                'streak' => $p->bestStreak, 'xp' => $p->xpEarned,
            ];

            if (!$p->isBot && $p->userId !== null) {
                try {
                    Progression::addStats($p->userId, [
                        'kills' => $p->kills, 'deaths' => $p->deaths, 'headshots' => $p->headshots,
                        'damage_dealt' => (int) round($p->damageDealt),
                        'matches_played' => 1, 'matches_won' => $won ? 1 : 0,
                        'best_streak' => $p->bestStreak, 'time_played' => $duration,
                    ]);
                    $entry['progression'] = Progression::award($p->userId, $p->xpEarned);
                } catch (\Throwable $e) {
                    error_log('[room] progression: ' . $e->getMessage());
                }
            }

            if ($this->matchId !== null) {
                try {
                    Database::pdo()->prepare(
                        'INSERT OR REPLACE INTO match_players
                         (match_id, user_id, display_name, team, kills, deaths, damage, xp_earned, is_bot)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
                    )->execute([
                        $this->matchId, $p->userId, $p->name, $p->team, $p->kills, $p->deaths,
                        (int) round($p->damageDealt), $p->xpEarned, $p->isBot ? 1 : 0,
                    ]);
                } catch (\Throwable $e) {
                    error_log('[room] match_players: ' . $e->getMessage());
                }
            }
            $summary[] = $entry;
        }

        if ($this->matchId !== null) {
            try {
                Database::pdo()->prepare(
                    'UPDATE matches SET ended_at = ?, score_a = ?, score_b = ? WHERE id = ?'
                )->execute([Database::now(), $this->score[0], $this->score[1], $this->matchId]);
            } catch (\Throwable $e) {
                error_log('[room] match update: ' . $e->getMessage());
            }
        }

        usort($summary, static fn(array $a, array $b): int => $b['kills'] <=> $a['kills']);
        $this->push(['t' => 'end', 'winner' => $winner, 'score' => $this->score, 'summary' => $summary]);
    }

    /* ---------------------------------------------------------- diffusion */

    public function push(array $event): void
    {
        $this->events[] = $event;
    }

    /** Vide la file d'evenements et renvoie le snapshot du tick. */
    public function drain(int $tick): array
    {
        $players = [];
        foreach ($this->players as $p) {
            $players[] = $p->snapshot();
        }
        $events = $this->events;
        $this->events = [];
        return [
            't' => 'snap',
            'k' => $tick,
            'now' => round($this->now(), 3),
            'p' => $players,
            'e' => $events,
            'score' => $this->score,
            'state' => $this->state,
            'left' => $this->state === self::LIVE ? max(0, (int) round($this->endsAt - $this->now())) : 0,
        ];
    }

    public function roster(): array
    {
        $out = [];
        foreach ($this->players as $p) {
            $out[] = $p->describe();
        }
        return $out;
    }

    public function now(): float
    {
        return microtime(true);
    }

    private static function jitterDirection(array $dir, float $spreadRad): array
    {
        if ($spreadRad <= 0) {
            return $dir;
        }
        // Base orthonormee autour de la direction de tir.
        $up = abs($dir[1]) > 0.95 ? [1.0, 0.0, 0.0] : [0.0, 1.0, 0.0];
        $right = [
            $up[1] * $dir[2] - $up[2] * $dir[1],
            $up[2] * $dir[0] - $up[0] * $dir[2],
            $up[0] * $dir[1] - $up[1] * $dir[0],
        ];
        $rl = sqrt($right[0] ** 2 + $right[1] ** 2 + $right[2] ** 2) ?: 1.0;
        $right = [$right[0] / $rl, $right[1] / $rl, $right[2] / $rl];
        $realUp = [
            $dir[1] * $right[2] - $dir[2] * $right[1],
            $dir[2] * $right[0] - $dir[0] * $right[2],
            $dir[0] * $right[1] - $dir[1] * $right[0],
        ];
        $ang = random_int(0, 62831) / 10000.0;
        $mag = sqrt(random_int(0, 10000) / 10000.0) * $spreadRad;
        $ox = cos($ang) * $mag;
        $oy = sin($ang) * $mag;
        return Ballistics::normalize([
            $dir[0] + $right[0] * $ox + $realUp[0] * $oy,
            $dir[1] + $right[1] * $ox + $realUp[1] * $oy,
            $dir[2] + $right[2] * $ox + $realUp[2] * $oy,
        ]);
    }
}
