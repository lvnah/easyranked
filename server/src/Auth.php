<?php
declare(strict_types=1);

namespace EasyRanked;

/** Comptes, jetons de session, classes (loadouts). */
final class Auth
{
    private const TOKEN_TTL = 86400 * 14;

    public static function register(string $username, string $password): array
    {
        $username = trim($username);
        if (!preg_match('/^[A-Za-z0-9_\-]{3,18}$/', $username)) {
            throw new \InvalidArgumentException('Pseudo invalide (3-18 caracteres alphanumeriques).');
        }
        if (strlen($password) < 6) {
            throw new \InvalidArgumentException('Mot de passe trop court (6 caracteres minimum).');
        }
        $pdo = Database::pdo();
        $exists = $pdo->prepare('SELECT id FROM users WHERE username = ?');
        $exists->execute([$username]);
        if ($exists->fetch() !== false) {
            throw new \InvalidArgumentException('Ce pseudo est deja pris.');
        }
        $pdo->prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
            ->execute([$username, password_hash($password, PASSWORD_DEFAULT), Database::now()]);
        $id = (int) $pdo->lastInsertId();
        $pdo->prepare('INSERT INTO progression (user_id) VALUES (?)')->execute([$id]);
        self::ensureLoadouts($id);

        return self::issueToken($id);
    }

    public static function login(string $username, string $password): array
    {
        $st = Database::pdo()->prepare('SELECT id, password_hash FROM users WHERE username = ?');
        $st->execute([trim($username)]);
        $u = $st->fetch();
        if ($u === false || !password_verify($password, (string) $u['password_hash'])) {
            throw new \InvalidArgumentException('Pseudo ou mot de passe incorrect.');
        }
        $id = (int) $u['id'];
        self::ensureLoadouts($id);
        return self::issueToken($id);
    }

    public static function issueToken(int $userId): array
    {
        $token = bin2hex(random_bytes(24));
        Database::pdo()
            ->prepare('UPDATE users SET token = ?, token_expires = ?, last_seen = ? WHERE id = ?')
            ->execute([$token, Database::now() + self::TOKEN_TTL, Database::now(), $userId]);
        return ['token' => $token, 'user' => self::profile($userId)];
    }

    /** @return array{id:int,username:string}|null */
    public static function userByToken(string $token): ?array
    {
        if ($token === '') {
            return null;
        }
        $st = Database::pdo()->prepare(
            'SELECT id, username FROM users WHERE token = ? AND token_expires > ?'
        );
        $st->execute([$token, Database::now()]);
        $u = $st->fetch();
        return $u === false ? null : ['id' => (int) $u['id'], 'username' => (string) $u['username']];
    }

    public static function logout(string $token): void
    {
        Database::pdo()->prepare('UPDATE users SET token = NULL, token_expires = 0 WHERE token = ?')
            ->execute([$token]);
    }

    public static function profile(int $userId): array
    {
        $st = Database::pdo()->prepare('SELECT id, username, created_at FROM users WHERE id = ?');
        $st->execute([$userId]);
        $u = $st->fetch();
        if ($u === false) {
            throw new \RuntimeException('Utilisateur introuvable.');
        }
        $prog = Progression::fetch($userId);
        return [
            'id'          => (int) $u['id'],
            'username'    => (string) $u['username'],
            'level'       => (int) $prog['level'],
            'xp'          => (int) $prog['xp'],
            'xpNext'      => (int) $prog['xpNext'],
            'gunsmith'    => (bool) $prog['gunsmith'],
            'stats'       => [
                'kills'   => (int) $prog['kills'],
                'deaths'  => (int) $prog['deaths'],
                'headshots' => (int) $prog['headshots'],
                'damage'  => (int) $prog['damage_dealt'],
                'matches' => (int) $prog['matches_played'],
                'wins'    => (int) $prog['matches_won'],
                'streak'  => (int) $prog['best_streak'],
                'time'    => (int) $prog['time_played'],
            ],
            'loadouts'    => self::loadouts($userId),
        ];
    }

    public static function ensureLoadouts(int $userId): void
    {
        $pdo = Database::pdo();
        $st = $pdo->prepare('SELECT COUNT(*) c FROM loadouts WHERE user_id = ?');
        $st->execute([$userId]);
        if ((int) $st->fetch()['c'] >= 5) {
            return;
        }
        $ins = $pdo->prepare(
            'INSERT OR IGNORE INTO loadouts (user_id, slot, name, weapon, updated_at) VALUES (?, ?, ?, ?, ?)'
        );
        $presets = [
            [0, 'Assaut', 'mk18'],
            [1, 'Eclaireur', 'mp5'],
            [2, 'Vetera', 'ak74'],
            [3, 'Tireur', 'mk12'],
            [4, 'Libre', 'mk18'],
        ];
        foreach ($presets as [$slot, $name, $weapon]) {
            $ins->execute([$userId, $slot, $name, $weapon, Database::now()]);
        }
    }

    /** @return list<array> */
    public static function loadouts(int $userId): array
    {
        self::ensureLoadouts($userId);
        $st = Database::pdo()->prepare('SELECT * FROM loadouts WHERE user_id = ? ORDER BY slot');
        $st->execute([$userId]);
        $out = [];
        foreach ($st->fetchAll() as $row) {
            $out[] = self::rowToLoadout($row);
        }
        return $out;
    }

    public static function loadout(int $userId, int $slot): array
    {
        self::ensureLoadouts($userId);
        $st = Database::pdo()->prepare('SELECT * FROM loadouts WHERE user_id = ? AND slot = ?');
        $st->execute([$userId, max(0, min(4, $slot))]);
        $row = $st->fetch();
        if ($row === false) {
            return ['slot' => 0, 'name' => 'Assaut', 'weapon' => 'mk18', 'camo' => 'default', 'attachments' => []];
        }
        return self::rowToLoadout($row);
    }

    public static function saveLoadout(int $userId, int $slot, array $data): array
    {
        $level = (int) Progression::fetch($userId)['level'];
        $clean = Config::sanitizeLoadout($data, $level);
        $name = trim((string) ($data['name'] ?? 'Classe'));
        if ($name === '' || mb_strlen($name) > 18) {
            $name = 'Classe';
        }
        $slot = max(0, min(4, $slot));
        self::ensureLoadouts($userId);
        Database::pdo()->prepare(
            'UPDATE loadouts SET name = ?, weapon = ?, camo = ?, att_optic = ?, att_barrel = ?,
             att_muzzle = ?, att_stock = ?, att_laser = ?, att_grip = ?, att_mag = ?, updated_at = ?
             WHERE user_id = ? AND slot = ?'
        )->execute([
            $name, $clean['weapon'], $clean['camo'],
            $clean['attachments']['optic'] ?? '',
            $clean['attachments']['barrel'] ?? '',
            $clean['attachments']['muzzle'] ?? '',
            $clean['attachments']['stock'] ?? '',
            $clean['attachments']['laser'] ?? '',
            $clean['attachments']['grip'] ?? '',
            $clean['attachments']['mag'] ?? '',
            Database::now(), $userId, $slot,
        ]);
        return self::loadout($userId, $slot);
    }

    private static function rowToLoadout(array $row): array
    {
        $att = [];
        foreach (['optic', 'barrel', 'muzzle', 'stock', 'laser', 'grip', 'mag'] as $slot) {
            $v = (string) ($row['att_' . $slot] ?? '');
            if ($v !== '') {
                $att[$slot] = $v;
            }
        }
        return [
            'slot'        => (int) $row['slot'],
            'name'        => (string) $row['name'],
            'weapon'      => (string) $row['weapon'],
            'camo'        => (string) $row['camo'],
            'attachments' => $att,
        ];
    }
}
