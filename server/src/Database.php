<?php
declare(strict_types=1);

namespace EasyRanked;

use PDO;

/** Acces SQLite partage (API HTTP + serveur WebSocket). */
final class Database
{
    private static ?PDO $pdo = null;

    public static function pdo(): PDO
    {
        if (self::$pdo instanceof PDO) {
            return self::$pdo;
        }
        $dir = Config::root() . '/data';
        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new \RuntimeException(
                "Impossible de creer le dossier {$dir}. Cree-le a la main et donne les droits "
                . "d'ecriture a l'utilisateur du serveur web (chmod 775)."
            );
        }
        if (!is_writable($dir)) {
            // Cas tres frequent en hebergement mutualise : dossier televerse en
            // lecture seule. SQLite a besoin d'ecrire le fichier ET son journal.
            throw new \RuntimeException(
                "Le dossier {$dir} n'est pas accessible en ecriture. SQLite doit pouvoir y creer "
                . "la base et son journal : applique chmod 775 (ou 777 si l'hebergeur l'exige)."
            );
        }
        $file = $dir . '/easyranked.sqlite';
        $fresh = !file_exists($file);

        $pdo = new PDO('sqlite:' . $file, null, null, [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]);
        $pdo->exec('PRAGMA foreign_keys = ON');
        $pdo->exec('PRAGMA journal_mode = WAL');
        $pdo->exec('PRAGMA busy_timeout = 5000');

        // Migration idempotente : le schema est toujours applique (CREATE IF NOT EXISTS).
        $schema = file_get_contents(Config::root() . '/server/schema.sql');
        if ($schema === false) {
            throw new \RuntimeException('schema.sql introuvable');
        }
        $pdo->exec($schema);
        if ($fresh) {
            error_log('[db] base creee: ' . $file);
        }

        return self::$pdo = $pdo;
    }

    public static function now(): int
    {
        return time();
    }
}
