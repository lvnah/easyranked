<?php
declare(strict_types=1);

namespace EasyRanked;

/** Etat autoritaire d'un combattant (joueur ou bot) dans une salle. */
class PlayerState
{
    public const HISTORY = 24;      // ~0.6 s a 40 Hz : fenetre de compensation de lag

    public int $team = 0;
    public bool $isBot = false;
    public ?int $userId = null;
    public int $level = 1;

    /** Position des pieds. */
    public array $pos = [0.0, 0.0, 0.0];
    public array $vel = [0.0, 0.0, 0.0];
    public float $yaw = 0.0;
    public float $pitch = 0.0;
    /** 1.0 debout, 0.62 accroupi / glissade. */
    public float $stance = 1.0;
    public bool $sprinting = false;
    public bool $ads = false;
    public bool $sliding = false;
    public bool $grounded = true;

    public float $health;
    public float $shield = 0.0;
    public bool $alive = true;
    public float $respawnAt = 0.0;
    public float $lastDamageAt = -99.0;
    public ?string $lastAttacker = null;
    public float $spawnProtectedUntil = 0.0;

    public int $ammo;
    public int $reserve;
    public int $grenades;
    public bool $reloading = false;
    public float $reloadDoneAt = 0.0;
    public float $nextShotAt = 0.0;
    public int $shotsInBurst = 0;
    public float $lastShotAt = -99.0;

    public int $kills = 0;
    public int $deaths = 0;
    public int $assists = 0;
    public float $damageDealt = 0.0;
    public int $streak = 0;
    public int $bestStreak = 0;
    public int $headshots = 0;
    public int $xpEarned = 0;

    /** Degats recus par attaquant depuis la derniere mort (pour les assistances). */
    public array $damageFrom = [];

    /** @var list<array{t:float,pos:array,stance:float}> */
    public array $history = [];

    public array $stats;          // Config::resolveWeapon(...)
    public array $loadout;
    public int $lastInputSeq = 0;
    public float $lastInputAt = 0.0;
    /** Anti-triche : distance parcourue cumulee sur la fenetre courante. */
    public float $moveBudget = 0.0;
    public int $warnings = 0;
    public float $lastCorrectionAt = 0.0;

    public function __construct(
        public string $id,
        public string $name,
        array $loadout,
        int $level = 1
    ) {
        $this->level   = $level;
        $this->loadout = $loadout;
        $this->stats   = Config::resolveWeapon($loadout['weapon'] ?? 'mk18', $loadout['attachments'] ?? []);
        $bal           = Config::balance();
        $this->health  = (float) $bal['maxHealth'];
        $this->shield  = (float) $bal['shieldMax'];
        $this->ammo    = (int) $this->stats['magazine'];
        $this->reserve = (int) $this->stats['reserve'];
        $this->grenades = (int) Config::weapons()['grenades']['count'];
    }

    public function applyLoadout(array $loadout): void
    {
        $this->loadout = $loadout;
        $this->stats = Config::resolveWeapon($loadout['weapon'] ?? 'mk18', $loadout['attachments'] ?? []);
    }

    public function eyeHeight(): float
    {
        return 1.62 * $this->stance;
    }

    public function eye(): array
    {
        return [$this->pos[0], $this->pos[1] + $this->eyeHeight(), $this->pos[2]];
    }

    public function record(float $now): void
    {
        $this->history[] = ['t' => $now, 'pos' => $this->pos, 'stance' => $this->stance];
        if (count($this->history) > self::HISTORY) {
            array_shift($this->history);
        }
    }

    /** Position interpolee a l'instant $t (compensation de lag). */
    public function at(float $t): array
    {
        $n = count($this->history);
        if ($n === 0) {
            return ['pos' => $this->pos, 'stance' => $this->stance];
        }
        if ($t >= $this->history[$n - 1]['t']) {
            return ['pos' => $this->history[$n - 1]['pos'], 'stance' => $this->history[$n - 1]['stance']];
        }
        if ($t <= $this->history[0]['t']) {
            return ['pos' => $this->history[0]['pos'], 'stance' => $this->history[0]['stance']];
        }
        for ($i = $n - 1; $i > 0; $i--) {
            $a = $this->history[$i - 1];
            $b = $this->history[$i];
            if ($t >= $a['t'] && $t <= $b['t']) {
                $span = max(1e-6, $b['t'] - $a['t']);
                $k = ($t - $a['t']) / $span;
                return [
                    'pos' => [
                        $a['pos'][0] + ($b['pos'][0] - $a['pos'][0]) * $k,
                        $a['pos'][1] + ($b['pos'][1] - $a['pos'][1]) * $k,
                        $a['pos'][2] + ($b['pos'][2] - $a['pos'][2]) * $k,
                    ],
                    'stance' => $a['stance'] + ($b['stance'] - $a['stance']) * $k,
                ];
            }
        }
        return ['pos' => $this->pos, 'stance' => $this->stance];
    }

    public function reset(array $spawn, float $now): void
    {
        $bal = Config::balance();
        $this->pos = [$spawn[0], $spawn[1], $spawn[2]];
        $this->vel = [0.0, 0.0, 0.0];
        $this->health = (float) $bal['maxHealth'];
        $this->shield = (float) $bal['shieldMax'];
        $this->alive = true;
        $this->stance = 1.0;
        $this->sliding = false;
        $this->ammo = (int) $this->stats['magazine'];
        $this->reserve = (int) $this->stats['reserve'];
        $this->grenades = (int) Config::weapons()['grenades']['count'];
        $this->reloading = false;
        $this->reloadDoneAt = 0.0;
        $this->nextShotAt = $now + 0.25;
        $this->shotsInBurst = 0;
        $this->damageFrom = [];
        $this->lastAttacker = null;
        $this->lastDamageAt = -99.0;
        $this->history = [];
        $this->spawnProtectedUntil = $now + 1.2;
    }

    /** @return array degats reellement appliques + etat */
    public function takeDamage(float $amount, string $from, float $now): array
    {
        if (!$this->alive || $now < $this->spawnProtectedUntil) {
            return ['applied' => 0.0, 'killed' => false];
        }
        $before = $this->health + $this->shield;
        if ($this->shield > 0) {
            $absorbed = min($this->shield, $amount);
            $this->shield -= $absorbed;
            $amount -= $absorbed;
        }
        $this->health = max(0.0, $this->health - $amount);
        $applied = $before - ($this->health + $this->shield);

        $this->lastDamageAt = $now;
        $this->lastAttacker = $from;
        $this->damageFrom[$from] = ($this->damageFrom[$from] ?? 0.0) + $applied;

        $killed = $this->health <= 0.0;
        if ($killed) {
            $this->alive = false;
            $this->deaths++;
            $this->streak = 0;
            $this->respawnAt = $now + (float) Config::balance()['respawnDelay'];
        }
        return ['applied' => $applied, 'killed' => $killed];
    }

    /**
     * Regeneration : le bouclier revient d'abord (plus vite, apres un delai plus
     * court), puis les points de vie. Total effectif : maxHealth + shieldMax.
     */
    public function regen(float $now, float $dt): void
    {
        if (!$this->alive) {
            return;
        }
        $bal = Config::balance();
        $since = $now - $this->lastDamageAt;
        if ($since >= $bal['shieldRegenDelay'] && $this->shield < $bal['shieldMax']) {
            $this->shield = min((float) $bal['shieldMax'], $this->shield + $bal['shieldRegenRate'] * $dt);
        }
        if ($since >= $bal['regenDelay']) {
            $this->health = min((float) $bal['maxHealth'], $this->health + $bal['regenRate'] * $dt);
        }
    }

    public function addKill(bool $headshot): void
    {
        $this->kills++;
        $this->streak++;
        $this->bestStreak = max($this->bestStreak, $this->streak);
        if ($headshot) {
            $this->headshots++;
        }
    }

    /** Vue compacte pour les snapshots (ordre fige, cf. net.js). */
    public function snapshot(): array
    {
        return [
            $this->id,
            round($this->pos[0], 2), round($this->pos[1], 2), round($this->pos[2], 2),
            round($this->yaw, 3), round($this->pitch, 3),
            round($this->stance, 2),
            (int) round($this->health),
            (int) round($this->shield),
            $this->alive ? 1 : 0,
            ($this->sprinting ? 1 : 0) | ($this->ads ? 2 : 0) | ($this->sliding ? 4 : 0)
                | ($this->grounded ? 8 : 0) | ($this->reloading ? 16 : 0),
            $this->kills, $this->deaths,
            $this->ammo,
            $this->lastInputSeq,
        ];
    }

    public function describe(): array
    {
        return [
            'id'       => $this->id,
            'name'     => $this->name,
            'team'     => $this->team,
            'bot'      => $this->isBot,
            'level'    => $this->level,
            'weapon'   => $this->loadout['weapon'] ?? 'mk18',
            'camo'     => $this->loadout['camo'] ?? 'default',
            'attachments' => $this->loadout['attachments'] ?? [],
            'magazine' => (int) $this->stats['magazine'],
            'reserve'  => $this->reserve,
        ];
    }
}
