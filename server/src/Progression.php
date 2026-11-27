<?php
declare(strict_types=1);

namespace EasyRanked;

/** Courbe d'XP et niveaux 1 -> 100. */
final class Progression
{
    public const MAX_LEVEL = 100;

    /** XP necessaire pour passer du niveau $level au suivant. */
    public static function xpForNext(int $level): int
    {
        if ($level >= self::MAX_LEVEL) {
            return PHP_INT_MAX;
        }
        // Progression douce au debut (deblocage Gunsmith au niv. 5 rapide), puis lineaire.
        return (int) round(900 + ($level - 1) * 230 + ($level ** 1.35) * 12);
    }

    /** Ajoute de l'XP et renvoie [level, xp, xpTotal, levelsGained]. */
    public static function award(int $userId, int $amount): array
    {
        $amount = max(0, $amount);
        $pdo = Database::pdo();
        $pdo->beginTransaction();
        try {
            $row = $pdo->prepare('SELECT level, xp, xp_total FROM progression WHERE user_id = ?');
            $row->execute([$userId]);
            $p = $row->fetch();
            if ($p === false) {
                $pdo->prepare('INSERT INTO progression (user_id) VALUES (?)')->execute([$userId]);
                $p = ['level' => 1, 'xp' => 0, 'xp_total' => 0];
            }
            $level = (int) $p['level'];
            $xp = (int) $p['xp'] + $amount;
            $total = (int) $p['xp_total'] + $amount;
            $gained = 0;
            while ($level < self::MAX_LEVEL && $xp >= self::xpForNext($level)) {
                $xp -= self::xpForNext($level);
                $level++;
                $gained++;
            }
            if ($level >= self::MAX_LEVEL) {
                $xp = 0;
            }
            $pdo->prepare('UPDATE progression SET level = ?, xp = ?, xp_total = ? WHERE user_id = ?')
                ->execute([$level, $xp, $total, $userId]);
            $pdo->commit();
            return ['level' => $level, 'xp' => $xp, 'xpTotal' => $total, 'levelsGained' => $gained,
                    'xpNext' => $level >= self::MAX_LEVEL ? 0 : self::xpForNext($level)];
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
    }

    public static function addStats(int $userId, array $delta): void
    {
        $allowed = ['kills', 'deaths', 'headshots', 'damage_dealt', 'matches_played',
                    'matches_won', 'time_played'];
        $sets = [];
        $args = [];
        foreach ($delta as $k => $v) {
            if (!in_array($k, $allowed, true)) {
                continue;
            }
            $sets[] = "{$k} = {$k} + ?";
            $args[] = (int) $v;
        }
        if (isset($delta['best_streak'])) {
            $sets[] = 'best_streak = MAX(best_streak, ?)';
            $args[] = (int) $delta['best_streak'];
        }
        if ($sets === []) {
            return;
        }
        $args[] = $userId;
        Database::pdo()
            ->prepare('UPDATE progression SET ' . implode(', ', $sets) . ' WHERE user_id = ?')
            ->execute($args);
    }

    public static function fetch(int $userId): array
    {
        $st = Database::pdo()->prepare('SELECT * FROM progression WHERE user_id = ?');
        $st->execute([$userId]);
        $p = $st->fetch();
        if ($p === false) {
            Database::pdo()->prepare('INSERT INTO progression (user_id) VALUES (?)')->execute([$userId]);
            $st->execute([$userId]);
            $p = $st->fetch();
        }
        $level = (int) $p['level'];
        $p['xpNext'] = $level >= self::MAX_LEVEL ? 0 : self::xpForNext($level);
        $p['gunsmith'] = $level >= 5;
        return $p;
    }
}
