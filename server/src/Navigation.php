<?php
declare(strict_types=1);

namespace EasyRanked;

/** Graphe de waypoints de l'arene + A* (partage par tous les bots). */
final class Navigation
{
    private static ?self $instance = null;

    /** @var list<array{p:array,n:list<int>,cover:int}> */
    public array $nodes;
    private array $byCell = [];
    private const CELL = 6.0;

    private function __construct()
    {
        $this->nodes = Config::arena()['waypoints'];
        foreach ($this->nodes as $i => $nd) {
            $key = $this->cellKey($nd['p'][0], $nd['p'][2]);
            $this->byCell[$key][] = $i;
        }
    }

    public static function get(): self
    {
        return self::$instance ??= new self();
    }

    private function cellKey(float $x, float $z): string
    {
        return ((int) floor($x / self::CELL)) . ':' . ((int) floor($z / self::CELL));
    }

    /** Waypoint le plus proche d'une position (recherche par cellules). */
    public function nearest(array $pos): int
    {
        $best = -1;
        $bestD = INF;
        for ($r = 1; $r <= 4 && $best < 0; $r++) {
            $cx = (int) floor($pos[0] / self::CELL);
            $cz = (int) floor($pos[2] / self::CELL);
            for ($dx = -$r; $dx <= $r; $dx++) {
                for ($dz = -$r; $dz <= $r; $dz++) {
                    foreach ($this->byCell[($cx + $dx) . ':' . ($cz + $dz)] ?? [] as $i) {
                        $p = $this->nodes[$i]['p'];
                        $d = ($p[0] - $pos[0]) ** 2 + ($p[2] - $pos[2]) ** 2;
                        if ($d < $bestD) {
                            $bestD = $d;
                            $best = $i;
                        }
                    }
                }
            }
        }
        if ($best < 0) {
            // Repli : balayage complet (ne devrait arriver que hors de l'arene).
            foreach ($this->nodes as $i => $nd) {
                $d = ($nd['p'][0] - $pos[0]) ** 2 + ($nd['p'][2] - $pos[2]) ** 2;
                if ($d < $bestD) {
                    $bestD = $d;
                    $best = $i;
                }
            }
        }
        return max(0, $best);
    }

    /**
     * A* entre deux waypoints.
     * @return list<int> suite d'indices (depart exclu), vide si inatteignable
     */
    public function path(int $from, int $to): array
    {
        if ($from === $to) {
            return [];
        }
        $n = count($this->nodes);
        if ($from < 0 || $to < 0 || $from >= $n || $to >= $n) {
            return [];
        }
        $goal = $this->nodes[$to]['p'];
        $g = array_fill(0, $n, INF);
        $came = array_fill(0, $n, -1);
        $g[$from] = 0.0;

        // File de priorite binaire (SplPriorityQueue trie en ordre decroissant).
        $open = new \SplPriorityQueue();
        $open->setExtractFlags(\SplPriorityQueue::EXTR_DATA);
        $open->insert($from, -$this->heuristic($from, $goal));
        $closed = array_fill(0, $n, false);

        while (!$open->isEmpty()) {
            /** @var int $cur */
            $cur = $open->extract();
            if ($cur === $to) {
                break;
            }
            if ($closed[$cur]) {
                continue;
            }
            $closed[$cur] = true;

            foreach ($this->nodes[$cur]['n'] as $nb) {
                if ($closed[$nb]) {
                    continue;
                }
                $a = $this->nodes[$cur]['p'];
                $b = $this->nodes[$nb]['p'];
                $step = sqrt(($a[0] - $b[0]) ** 2 + ($a[2] - $b[2]) ** 2);
                $tentative = $g[$cur] + $step;
                if ($tentative < $g[$nb] - 1e-6) {
                    $g[$nb] = $tentative;
                    $came[$nb] = $cur;
                    $open->insert($nb, -($tentative + $this->heuristic($nb, $goal)));
                }
            }
        }

        if ($came[$to] === -1 && $to !== $from) {
            return [];
        }
        $path = [];
        for ($k = $to; $k !== -1 && $k !== $from; $k = $came[$k]) {
            array_unshift($path, $k);
            if (count($path) > $n) {
                return [];   // garde-fou
            }
        }
        return $path;
    }

    private function heuristic(int $i, array $goal): float
    {
        $p = $this->nodes[$i]['p'];
        return sqrt(($p[0] - $goal[0]) ** 2 + ($p[2] - $goal[2]) ** 2);
    }

    /** Waypoint de couverture : proche du bot, loin de la menace, avec un bon score d'abri. */
    public function coverNear(array $pos, array $threat, Ballistics $bal, float $radius = 16.0): int
    {
        $best = -1;
        $bestScore = -INF;
        foreach ($this->nodes as $i => $nd) {
            $d = sqrt(($nd['p'][0] - $pos[0]) ** 2 + ($nd['p'][2] - $pos[2]) ** 2);
            if ($d > $radius || $nd['cover'] === 0) {
                continue;
            }
            $eye = [$nd['p'][0], $nd['p'][1] + 1.0, $nd['p'][2]];
            $hidden = $bal->lineOfSight($eye, $threat) ? 0.0 : 1.0;
            $distThreat = sqrt(($nd['p'][0] - $threat[0]) ** 2 + ($nd['p'][2] - $threat[2]) ** 2);
            $score = $hidden * 9.0 + $nd['cover'] * 1.6 - $d * 0.32 + min($distThreat, 26.0) * 0.1;
            if ($score > $bestScore) {
                $bestScore = $score;
                $best = $i;
            }
        }
        return $best;
    }

    public function randomNode(): int
    {
        return random_int(0, count($this->nodes) - 1);
    }
}
