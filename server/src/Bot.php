<?php
declare(strict_types=1);

namespace EasyRanked;

/**
 * Bot autonome : navigation par waypoints (A*), prise de couverture,
 * tir avec dispersion et temps de reaction realistes.
 */
final class Bot extends PlayerState
{
    public const PATROL = 'patrol';
    public const ENGAGE = 'engage';
    public const COVER  = 'cover';
    public const HUNT   = 'hunt';

    public string $state = self::PATROL;
    public float $skill = 0.6;              // 0 = recrue, 1 = veteran

    private array $path = [];               // indices de waypoints restants
    private int $goalNode = -1;
    private float $repathAt = 0.0;
    private ?string $targetId = null;
    private float $targetSeenAt = -99.0;
    private array $lastKnownPos = [0.0, 0.0, 0.0];
    private float $reactionUntil = 0.0;
    private float $burstUntil = 0.0;
    private float $burstPauseUntil = 0.0;
    private float $strafeDir = 1.0;
    private float $strafeFlipAt = 0.0;
    private array $aimYawPitch = [0.0, 0.0];
    private float $jitterAt = 0.0;
    private array $jitter = [0.0, 0.0];

    public function __construct(string $id, string $name, array $loadout, float $skill, int $level = 1)
    {
        parent::__construct($id, $name, $loadout, $level);
        $this->isBot = true;
        $this->skill = max(0.0, min(1.0, $skill));
    }

    public function tick(float $now, float $dt, Room $room): void
    {
        if (!$this->alive) {
            return;
        }
        $nav = Navigation::get();
        $bal = $room->ballistics();

        $this->perceive($now, $room, $bal);
        $this->decide($now, $nav, $bal);
        $this->navigate($now, $dt, $nav);
        $this->aimAndFire($now, $dt, $room, $bal);
    }

    /* --------------------------------------------------------- perception */
    private function perceive(float $now, Room $room, Ballistics $bal): void
    {
        $eye = $this->eye();
        $best = null;
        $bestScore = -INF;

        foreach ($room->players() as $p) {
            if ($p->id === $this->id || $p->team === $this->team || !$p->alive) {
                continue;
            }
            $tgt = [$p->pos[0], $p->pos[1] + 1.25 * $p->stance, $p->pos[2]];
            $dx = $tgt[0] - $eye[0];
            $dy = $tgt[1] - $eye[1];
            $dz = $tgt[2] - $eye[2];
            $dist = sqrt($dx * $dx + $dy * $dy + $dz * $dz);
            if ($dist > 70.0) {
                continue;
            }
            // Champ de vision ~ 200 deg (le bot "entend" aussi dans son dos de pres).
            $fwd = [sin($this->yaw), 0.0, -cos($this->yaw)];
            $dot = ($dx * $fwd[0] + $dz * $fwd[2]) / max(1e-4, sqrt($dx * $dx + $dz * $dz));
            $audible = $dist < 11.0 && $now - $p->lastShotAt < 1.4;
            if ($dot < -0.34 && !$audible) {
                continue;
            }
            if (!$bal->lineOfSight($eye, $tgt)) {
                continue;
            }
            $score = 100.0 - $dist + ($p->id === $this->targetId ? 14.0 : 0.0)
                   + ($p->health < 60 ? 18.0 : 0.0);
            if ($score > $bestScore) {
                $bestScore = $score;
                $best = $p;
            }
        }

        if ($best !== null) {
            if ($best->id !== $this->targetId) {
                // Temps de reaction : 320 ms (recrue) -> 110 ms (veteran).
                $this->reactionUntil = $now + (0.32 - 0.21 * $this->skill);
                $this->targetId = $best->id;
            }
            $this->targetSeenAt = $now;
            $this->lastKnownPos = $best->pos;
        } elseif ($now - $this->targetSeenAt > 2.6) {
            $this->targetId = null;
        }
    }

    /* ----------------------------------------------------------- decision */
    private function decide(float $now, Navigation $nav, Ballistics $bal): void
    {
        $visible = $this->targetId !== null && ($now - $this->targetSeenAt) < 0.35;
        $lowHp   = $this->health < 60.0;
        $noAmmo  = $this->ammo === 0;

        if (($lowHp || $noAmmo) && ($visible || $now - $this->targetSeenAt < 2.0)) {
            $this->setState(self::COVER, $now);
        } elseif ($visible) {
            $this->setState(self::ENGAGE, $now);
        } elseif ($this->targetId !== null) {
            $this->setState(self::HUNT, $now);
        } else {
            $this->setState(self::PATROL, $now);
        }

        if ($now < $this->repathAt && $this->path !== []) {
            return;
        }
        $this->repathAt = $now + 0.6 + (1.0 - $this->skill) * 0.5;
        $from = $nav->nearest($this->pos);

        $goal = match ($this->state) {
            self::COVER  => $nav->coverNear($this->pos, $this->lastKnownPos, $bal, 18.0),
            self::ENGAGE => $this->engagementNode($nav, $bal, $from),
            self::HUNT   => $nav->nearest($this->lastKnownPos),
            default      => $this->patrolNode($nav, $from),
        };
        if ($goal < 0) {
            $goal = $nav->randomNode();
        }
        if ($goal !== $this->goalNode || $this->path === []) {
            $this->goalNode = $goal;
            $this->path = $nav->path($from, $goal);
        }
    }

    private function setState(string $s, float $now): void
    {
        if ($this->state !== $s) {
            $this->state = $s;
            $this->repathAt = 0.0;         // force un recalcul immediat
        }
    }

    /** En combat : tenir une distance d'engagement adaptee a l'arme. */
    private function engagementNode(Navigation $nav, Ballistics $bal, int $from): int
    {
        $ideal = min(28.0, max(7.0, $this->stats['rangeFull'] * 0.55));
        $tgt = $this->lastKnownPos;
        $best = -1;
        $bestScore = -INF;
        foreach ($nav->nodes as $i => $nd) {
            $dSelf = sqrt(($nd['p'][0] - $this->pos[0]) ** 2 + ($nd['p'][2] - $this->pos[2]) ** 2);
            if ($dSelf > 14.0) {
                continue;
            }
            $dT = sqrt(($nd['p'][0] - $tgt[0]) ** 2 + ($nd['p'][2] - $tgt[2]) ** 2);
            $eye = [$nd['p'][0], $nd['p'][1] + 1.55, $nd['p'][2]];
            $shootable = $bal->lineOfSight($eye, [$tgt[0], $tgt[1] + 1.25, $tgt[2]]) ? 1.0 : 0.0;
            $score = $shootable * 6.0 - abs($dT - $ideal) * 0.5 + $nd['cover'] * 1.1 - $dSelf * 0.12;
            if ($score > $bestScore) {
                $bestScore = $score;
                $best = $i;
            }
        }
        return $best >= 0 ? $best : $from;
    }

    /** Patrouille : un noeud eloigne, de preference vers le milieu de la carte. */
    private function patrolNode(Navigation $nav, int $from): int
    {
        $tries = 0;
        do {
            $cand = $nav->randomNode();
            $p = $nav->nodes[$cand]['p'];
            $d = sqrt(($p[0] - $this->pos[0]) ** 2 + ($p[2] - $this->pos[2]) ** 2);
            if ($d > 12.0) {
                return $cand;
            }
        } while (++$tries < 8);
        return $nav->randomNode();
    }

    /* ---------------------------------------------------------- navigation */
    private function navigate(float $now, float $dt, Navigation $nav): void
    {
        $speed = 5.9 * $this->stats['mobility'];
        if ($this->state === self::PATROL) {
            $speed *= 1.1;                      // sprint en deplacement libre
            $this->sprinting = true;
        } else {
            $this->sprinting = false;
        }
        if ($this->state === self::COVER) {
            $speed *= 1.14;
        }
        $this->stance = 1.0;

        // Pas de cible de deplacement : on se contente du strafe de combat.
        if ($this->path === []) {
            $this->combatStrafe($now, $dt, $speed * 0.55);
            return;
        }
        $node = $nav->nodes[$this->path[0]]['p'];
        $dx = $node[0] - $this->pos[0];
        $dz = $node[2] - $this->pos[2];
        $dist = sqrt($dx * $dx + $dz * $dz);
        if ($dist < 1.1) {
            array_shift($this->path);
            if ($this->path === []) {
                return;
            }
            $node = $nav->nodes[$this->path[0]]['p'];
            $dx = $node[0] - $this->pos[0];
            $dz = $node[2] - $this->pos[2];
            $dist = max(1e-4, sqrt($dx * $dx + $dz * $dz));
        }
        $step = min($speed * $dt, $dist);
        $this->pos[0] += ($dx / $dist) * $step;
        $this->pos[2] += ($dz / $dist) * $step;
        $this->pos[1] = 0.0;
        $this->vel = [($dx / $dist) * $speed, 0.0, ($dz / $dist) * $speed];
        $this->grounded = true;

        // En combat on ajoute un decalage lateral pour ne pas etre une cible fixe.
        if ($this->state === self::ENGAGE) {
            $this->combatStrafe($now, $dt, $speed * 0.4);
        }
    }

    private function combatStrafe(float $now, float $dt, float $speed): void
    {
        if ($now > $this->strafeFlipAt) {
            $this->strafeDir = random_int(0, 1) ? 1.0 : -1.0;
            $this->strafeFlipAt = $now + 0.6 + (random_int(0, 100) / 100.0) * 1.1;
        }
        $right = [cos($this->yaw), 0.0, sin($this->yaw)];
        $nx = $this->pos[0] + $right[0] * $this->strafeDir * $speed * $dt;
        $nz = $this->pos[2] + $right[2] * $this->strafeDir * $speed * $dt;
        $b = Config::arena()['bounds'];
        if (abs($nx) < $b['w'] / 2 - 2.5 && abs($nz) < $b['d'] / 2 - 2.5) {
            $this->pos[0] = $nx;
            $this->pos[2] = $nz;
        } else {
            $this->strafeFlipAt = 0.0;
        }
    }

    /* ------------------------------------------------------------ visee/tir */
    private function aimAndFire(float $now, float $dt, Room $room, Ballistics $bal): void
    {
        $target = $this->targetId !== null ? $room->player($this->targetId) : null;

        if ($target === null || !$target->alive) {
            // Oriente le regard vers le prochain waypoint.
            if ($this->path !== []) {
                $n = Navigation::get()->nodes[$this->path[0]]['p'];
                $this->yaw = atan2($n[0] - $this->pos[0], -($n[2] - $this->pos[2]));
            }
            $this->pitch *= 0.9;
            $this->ads = false;
            $this->maybeReload($now);
            return;
        }

        $eye = $this->eye();
        $aimAt = [
            $target->pos[0],
            $target->pos[1] + (1.25 + 0.26 * $this->skill) * $target->stance,   // les bons bots visent plus haut
            $target->pos[2],
        ];
        // Anticipation du deplacement de la cible (lead), proportionnelle au niveau.
        $lead = 0.085 * $this->skill;
        $aimAt[0] += $target->vel[0] * $lead;
        $aimAt[2] += $target->vel[2] * $lead;

        $dx = $aimAt[0] - $eye[0];
        $dy = $aimAt[1] - $eye[1];
        $dz = $aimAt[2] - $eye[2];
        $dist = max(0.3, sqrt($dx * $dx + $dy * $dy + $dz * $dz));

        // Bruit de visee : tremblement recalcule 6 fois par seconde.
        if ($now > $this->jitterAt) {
            $this->jitterAt = $now + 0.16;
            $amp = (1.0 - $this->skill) * 0.055 + 0.008;
            $this->jitter = [
                (random_int(-1000, 1000) / 1000.0) * $amp,
                (random_int(-1000, 1000) / 1000.0) * $amp * 0.6,
            ];
        }

        $wantYaw = atan2($dx, -$dz) + $this->jitter[0];
        $wantPitch = asin(max(-1.0, min(1.0, $dy / $dist))) + $this->jitter[1];

        // Vitesse de rotation : 4 rad/s (recrue) -> 13 rad/s (veteran).
        $turn = (4.0 + 9.0 * $this->skill) * $dt;
        $this->yaw += self::wrapAngle($wantYaw - $this->yaw) * min(1.0, $turn);
        $this->pitch += ($wantPitch - $this->pitch) * min(1.0, $turn);
        $this->pitch = max(-1.4, min(1.4, $this->pitch));
        $this->ads = $dist > 12.0;

        if ($this->maybeReload($now)) {
            return;
        }
        if ($now < $this->reactionUntil || $now < $this->nextShotAt || $this->reloading) {
            return;
        }
        if (!$bal->lineOfSight($eye, $aimAt)) {
            return;
        }
        // Discipline de rafale : le bot relache la detente regulierement.
        if ($now < $this->burstPauseUntil) {
            return;
        }
        if ($now > $this->burstUntil) {
            $burstLen = 0.18 + $this->skill * 0.3;
            $this->burstUntil = $now + $burstLen;
            $this->burstPauseUntil = 0.0;
        }

        // Alignement reel requis avant de tirer (evite les tirs a 90 deg).
        $fwd = [sin($this->yaw) * cos($this->pitch), sin($this->pitch), -cos($this->yaw) * cos($this->pitch)];
        $aimDot = ($dx * $fwd[0] + $dy * $fwd[1] + $dz * $fwd[2]) / $dist;
        if ($aimDot < 0.985) {
            return;
        }

        $room->botShoot($this, $fwd, $now);

        if ($now >= $this->burstUntil) {
            $this->burstPauseUntil = $now + 0.12 + (1.0 - $this->skill) * 0.3;
            $this->burstUntil = 0.0;
        }
    }

    private function maybeReload(float $now): bool
    {
        if ($this->reloading) {
            return true;
        }
        $lowMag = $this->ammo <= max(2, (int) ($this->stats['magazine'] * 0.12));
        $safe = $this->targetId === null || $now - $this->targetSeenAt > 1.4;
        if ($this->ammo === 0 || ($lowMag && $safe)) {
            if ($this->reserve > 0) {
                $this->reloading = true;
                $this->reloadDoneAt = $now + ($this->ammo === 0
                    ? $this->stats['reloadEmptyTime']
                    : $this->stats['reloadTime']);
                return true;
            }
            // Plus de reserve : on recharge symboliquement (les bots ne restent pas inertes).
            $this->reserve = (int) $this->stats['reserve'];
        }
        return false;
    }

    public static function wrapAngle(float $a): float
    {
        while ($a > M_PI) {
            $a -= 2 * M_PI;
        }
        while ($a < -M_PI) {
            $a += 2 * M_PI;
        }
        return $a;
    }

    /** Dispersion appliquee au tir d'un bot (en degres). */
    public function spreadDegrees(): float
    {
        $base = $this->ads ? $this->stats['spreadAds'] : $this->stats['spreadHip'];
        $skillMul = 2.1 - 1.35 * $this->skill;          // recrue : x2.1, veteran : x0.75
        $moving = sqrt($this->vel[0] ** 2 + $this->vel[2] ** 2) > 1.0 ? 1.25 : 1.0;
        return $base * $skillMul * $moving;
    }
}
