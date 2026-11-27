<?php
declare(strict_types=1);

namespace EasyRanked;

/**
 * Validation autoritaire des tirs cote serveur.
 *
 * Le client envoie origine + direction ; le serveur refait le lancer de rayon
 * contre sa propre copie du monde (murs de l'arene) et contre les hitboxes des
 * joueurs telles qu'il les connait. Le client ne decide jamais des degats.
 */
final class Ballistics
{
    /** @var list<array{0:float,1:float,2:float,3:float,4:float,5:float}> AABB min/max */
    private array $boxes = [];

    public function __construct()
    {
        $arena = Config::arena();

        foreach ($arena['solids'] as $s) {
            if (!($s['collide'] ?? true)) {
                continue;
            }
            [$x, $y, $z] = $s['pos'];
            [$w, $h, $d] = $s['size'];
            // Les volumes solides sont alignes aux axes (rotations multiples de 90 deg).
            if (abs(sin((float) ($s['ry'] ?? 0))) > 0.5) {
                [$w, $d] = [$d, $w];
            }
            $this->boxes[] = [
                $x - $w / 2, $y - $h / 2, $z - $d / 2,
                $x + $w / 2, $y + $h / 2, $z + $d / 2,
            ];
        }
        foreach ($arena['instanced'] as $grp) {
            if (!($grp['collide'] ?? false)) {
                continue;
            }
            $r = (float) ($grp['radius'] ?? 0.5);
            foreach ($grp['transforms'] as $t) {
                $h = $grp['kind'] === 'barrel' ? 1.16 : 0.9 * (float) ($t[4] ?? 1);
                $rr = $r * ($grp['kind'] === 'barrel' ? 1 : (float) ($t[4] ?? 1));
                $this->boxes[] = [
                    $t[0] - $rr, 0.0, $t[2] - $rr,
                    $t[0] + $rr, $h, $t[2] + $rr,
                ];
            }
        }
    }

    public function colliderCount(): int
    {
        return count($this->boxes);
    }

    /**
     * Distance jusqu'au premier mur rencontre, ou INF.
     * Slab method sur AABB, sans allocation dans la boucle chaude.
     */
    public function rayWorld(array $o, array $d, float $maxDist): float
    {
        $d = self::normalize($d);
        // Inverses finis : 1/0 leve une exception en PHP et INF*0 donne NAN,
        // ce qui casserait silencieusement les min/max de la methode des tranches.
        $invX = self::inv((float) $d[0]);
        $invY = self::inv((float) $d[1]);
        $invZ = self::inv((float) $d[2]);
        $best = $maxDist;

        foreach ($this->boxes as $b) {
            $t1 = ($b[0] - $o[0]) * $invX;
            $t2 = ($b[3] - $o[0]) * $invX;
            $tmin = min($t1, $t2);
            $tmax = max($t1, $t2);

            $t1 = ($b[1] - $o[1]) * $invY;
            $t2 = ($b[4] - $o[1]) * $invY;
            $tmin = max($tmin, min($t1, $t2));
            $tmax = min($tmax, max($t1, $t2));

            $t1 = ($b[2] - $o[2]) * $invZ;
            $t2 = ($b[5] - $o[2]) * $invZ;
            $tmin = max($tmin, min($t1, $t2));
            $tmax = min($tmax, max($t1, $t2));

            if ($tmax >= max($tmin, 0.0) && $tmin < $best && $tmin >= 0.0) {
                $best = $tmin;
            }
        }
        return $best < $maxDist ? $best : INF;
    }

    private static function inv(float $v): float
    {
        if ($v > 1e-12) {
            return 1.0 / $v;
        }
        if ($v < -1e-12) {
            return 1.0 / $v;
        }
        return $v >= 0.0 ? 1e12 : -1e12;
    }

    /** @param array $v @return array{0:float,1:float,2:float} */
    public static function normalize(array $v): array
    {
        $x = (float) ($v[0] ?? 0.0);
        $y = (float) ($v[1] ?? 0.0);
        $z = (float) ($v[2] ?? 0.0);
        $len = sqrt($x * $x + $y * $y + $z * $z);
        if ($len < 1e-9) {
            return [0.0, 0.0, 1.0];
        }
        return [$x / $len, $y / $len, $z / $len];
    }

    public function lineOfSight(array $a, array $b): bool
    {
        $dx = $b[0] - $a[0];
        $dy = $b[1] - $a[1];
        $dz = $b[2] - $a[2];
        $len = sqrt($dx * $dx + $dy * $dy + $dz * $dz);
        if ($len < 1e-4) {
            return true;
        }
        $dir = [$dx / $len, $dy / $len, $dz / $len];
        return $this->rayWorld($a, $dir, $len - 0.05) === INF;
    }

    /**
     * Hitboxes d'un joueur, en coordonnees monde (origine = pieds).
     * @return list<array{zone:string,mul:float,type:string,c:array,he:array,r:float}>
     */
    public static function hitboxes(array $feet, float $stance): array
    {
        // stance : 1.0 debout, ~0.62 accroupi/glissade -> les volumes s'ecrasent.
        $s = max(0.55, min(1.0, $stance));
        $y = static fn(float $h): float => $feet[1] + $h * $s;

        return [
            ['zone' => 'head', 'mul' => 1.85, 'type' => 'sphere',
             'c' => [$feet[0], $y(1.655), $feet[2]], 'he' => [0, 0, 0], 'r' => 0.155],
            ['zone' => 'chest', 'mul' => 1.0, 'type' => 'box',
             'c' => [$feet[0], $y(1.26), $feet[2]], 'he' => [0.26, 0.21 * $s, 0.19], 'r' => 0],
            ['zone' => 'stomach', 'mul' => 1.0, 'type' => 'box',
             'c' => [$feet[0], $y(0.93), $feet[2]], 'he' => [0.23, 0.15 * $s, 0.17], 'r' => 0],
            // Deux bras lateraux distincts : un tir de flanc traverse le bras PUIS
            // le torse, il ne doit pas etre requalifie en tir de membre.
            ['zone' => 'arm_l', 'mul' => 0.82, 'type' => 'box',
             'c' => [$feet[0] - 0.355, $y(1.20), $feet[2]], 'he' => [0.1, 0.22 * $s, 0.14], 'r' => 0],
            ['zone' => 'arm_r', 'mul' => 0.82, 'type' => 'box',
             'c' => [$feet[0] + 0.355, $y(1.20), $feet[2]], 'he' => [0.1, 0.22 * $s, 0.14], 'r' => 0],
            ['zone' => 'legs', 'mul' => 0.82, 'type' => 'box',
             'c' => [$feet[0], $y(0.42), $feet[2]], 'he' => [0.23, 0.42 * $s, 0.18], 'r' => 0],
        ];
    }

    /**
     * Premier impact du rayon sur un joueur.
     * @return array{dist:float,zone:string,mul:float}|null
     */
    public static function rayPlayer(array $o, array $d, array $feet, float $stance, float $maxDist): ?array
    {
        // Rejet rapide : sphere englobante de 1.1 m de rayon autour du buste.
        $cx = $feet[0] - $o[0];
        $cy = ($feet[1] + 0.95 * $stance) - $o[1];
        $cz = $feet[2] - $o[2];
        $proj = $cx * $d[0] + $cy * $d[1] + $cz * $d[2];
        if ($proj < -1.2 || $proj > $maxDist + 1.2) {
            return null;
        }
        $perp2 = ($cx * $cx + $cy * $cy + $cz * $cz) - $proj * $proj;
        if ($perp2 > 1.35) {
            return null;
        }

        $best = null;
        foreach (self::hitboxes($feet, $stance) as $hb) {
            $t = $hb['type'] === 'sphere'
                ? self::raySphere($o, $d, $hb['c'], $hb['r'], $maxDist)
                : self::rayBox($o, $d, $hb['c'], $hb['he'], $maxDist);
            if ($t === null) {
                continue;
            }
            // A egalite de distance la tete prime (zone la plus petite, englobee par 'arms').
            if ($best === null || $t < $best['dist'] - 1e-6
                || (abs($t - $best['dist']) <= 1e-6 && $hb['mul'] > $best['mul'])) {
                $best = ['dist' => $t, 'zone' => $hb['zone'], 'mul' => $hb['mul']];
            }
        }
        return $best;
    }

    private static function raySphere(array $o, array $d, array $c, float $r, float $maxDist): ?float
    {
        $ox = $o[0] - $c[0];
        $oy = $o[1] - $c[1];
        $oz = $o[2] - $c[2];
        $b = $ox * $d[0] + $oy * $d[1] + $oz * $d[2];
        $cc = $ox * $ox + $oy * $oy + $oz * $oz - $r * $r;
        $disc = $b * $b - $cc;
        if ($disc < 0) {
            return null;
        }
        $t = -$b - sqrt($disc);
        if ($t < 0) {
            $t = -$b + sqrt($disc);
        }
        return ($t >= 0 && $t <= $maxDist) ? $t : null;
    }

    private static function rayBox(array $o, array $d, array $c, array $he, float $maxDist): ?float
    {
        $tmin = -INF;
        $tmax = INF;
        for ($i = 0; $i < 3; $i++) {
            $lo = $c[$i] - $he[$i];
            $hi = $c[$i] + $he[$i];
            if (abs($d[$i]) < 1e-9) {
                if ($o[$i] < $lo || $o[$i] > $hi) {
                    return null;
                }
                continue;
            }
            $inv = 1.0 / $d[$i];
            $t1 = ($lo - $o[$i]) * $inv;
            $t2 = ($hi - $o[$i]) * $inv;
            if ($t1 > $t2) {
                [$t1, $t2] = [$t2, $t1];
            }
            $tmin = max($tmin, $t1);
            $tmax = min($tmax, $t2);
            if ($tmin > $tmax) {
                return null;
            }
        }
        $t = $tmin >= 0 ? $tmin : $tmax;
        return ($t >= 0 && $t <= $maxDist) ? $t : null;
    }

    /** Degats en fonction de la distance (plateau puis chute lineaire). */
    public static function damageAtRange(array $stats, float $dist): float
    {
        if ($dist <= $stats['rangeFull']) {
            return (float) $stats['damage'];
        }
        if ($dist >= $stats['rangeFalloff']) {
            return $stats['damage'] * $stats['falloffMin'];
        }
        $t = ($dist - $stats['rangeFull']) / max(1e-3, $stats['rangeFalloff'] - $stats['rangeFull']);
        return $stats['damage'] * (1.0 - $t * (1.0 - $stats['falloffMin']));
    }
}
