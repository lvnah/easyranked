<?php
declare(strict_types=1);

namespace EasyRanked;

/**
 * Charge et met en cache les fichiers de configuration partages avec le client
 * (shared/arena.json, shared/weapons.json). Source unique de verite : le
 * serveur valide les tirs avec exactement les memes chiffres que le client
 * utilise pour le rendu et la prediction.
 */
final class Config
{
    private static ?array $arena = null;
    private static ?array $weapons = null;

    public static function root(): string
    {
        return \dirname(__DIR__, 2);
    }

    public static function arena(): array
    {
        return self::$arena ??= self::load('shared/arena.json');
    }

    public static function weapons(): array
    {
        return self::$weapons ??= self::load('shared/weapons.json');
    }

    public static function balance(): array
    {
        return self::weapons()['balance'];
    }

    public static function mode(string $mode): array
    {
        $modes = self::weapons()['modes'];
        return $modes[$mode] ?? $modes['2v2'];
    }

    /** Stats d'une arme, accessoires appliques. */
    public static function resolveWeapon(string $weaponId, array $attachments = []): array
    {
        $cfg = self::weapons();
        $w = $cfg['weapons'][$weaponId] ?? $cfg['weapons']['mk18'];
        $s = [
            'id'            => $weaponId,
            'name'          => $w['name'],
            'damage'        => (float) $w['damage'],
            'rpm'           => (float) $w['rpm'],
            'magazine'      => (int) $w['magazine'],
            'reserve'       => (int) $w['reserve'],
            'reloadTime'    => (float) $w['reloadTime'],
            'reloadEmptyTime' => (float) $w['reloadEmptyTime'],
            'adsTime'       => (float) $w['adsTime'],
            'spreadHip'     => (float) $w['spreadHip'],
            'spreadAds'     => (float) $w['spreadAds'],
            'spreadMoveMul' => (float) $w['spreadMoveMul'],
            'recoilVert'    => (float) $w['recoil']['vert'],
            'recoilHoriz'   => (float) $w['recoil']['horiz'],
            'recovery'      => (float) $w['recoil']['recovery'],
            'kick'          => (float) $w['recoil']['kick'],
            'pattern'       => (float) $w['recoil']['pattern'],
            'rangeFull'     => (float) $w['rangeFull'],
            'rangeFalloff'  => (float) $w['rangeFalloff'],
            'falloffMin'    => (float) $w['falloffMin'],
            'mobility'      => (float) $w['mobility'],
            'bulletsPerShot'=> (int) $w['bulletsPerShot'],
            'auto'          => (bool) $w['auto'],
            'shape'         => $w['shape'],
            'zoom'          => 1.12,
            'silent'        => false,
            'visibleLaser'  => false,
        ];

        $map = [
            'adsTime' => 'adsTime', 'spreadAds' => 'spreadAds', 'spreadHip' => 'spreadHip',
            'spreadMoveMul' => 'spreadMoveMul', 'recoilVert' => 'recoilVert',
            'recoilHoriz' => 'recoilHoriz', 'rangeFull' => 'rangeFull',
            'rangeFalloff' => 'rangeFalloff', 'mobility' => 'mobility',
            'magazine' => 'magazine', 'reloadTime' => 'reloadTime',
        ];

        foreach ($cfg['slots'] as $slot) {
            $chosen = $attachments[$slot] ?? '';
            if ($chosen === '') {
                continue;
            }
            foreach ($cfg['attachments'][$slot] ?? [] as $att) {
                if ($att['id'] !== $chosen) {
                    continue;
                }
                foreach ($att['mods'] as $key => $delta) {
                    if (isset($map[$key])) {
                        $s[$map[$key]] += $delta;
                    } elseif ($key === 'zoom') {
                        $s['zoom'] = (float) $delta;
                    } elseif ($key === 'silent') {
                        $s['silent'] = true;
                    } elseif ($key === 'visibleLaser') {
                        $s['visibleLaser'] = true;
                    }
                }
            }
        }

        // Bornes de securite : un empilage d'accessoires ne doit jamais casser l'equilibrage.
        $s['adsTime']       = max(0.1, $s['adsTime']);
        $s['spreadAds']     = max(0.04, $s['spreadAds']);
        $s['spreadHip']     = max(0.5, $s['spreadHip']);
        $s['recoilVert']    = max(0.12, $s['recoilVert']);
        $s['recoilHoriz']   = max(0.05, $s['recoilHoriz']);
        $s['reloadTime']    = max(0.9, $s['reloadTime']);
        $s['reloadEmptyTime'] = max(1.1, $s['reloadEmptyTime'] + ($s['reloadTime'] - (float) $w['reloadTime']));
        $s['mobility']      = max(0.75, min(1.25, $s['mobility']));
        $s['magazine']      = max(5, $s['magazine']);
        $s['rangeFull']     = max(8.0, $s['rangeFull']);
        $s['rangeFalloff']  = max($s['rangeFull'] + 6.0, $s['rangeFalloff']);
        $s['fireInterval']  = 60.0 / max(60.0, $s['rpm']);

        return $s;
    }

    /** Verifie qu'une classe n'utilise que du contenu debloque au niveau donne. */
    public static function sanitizeLoadout(array $loadout, int $level): array
    {
        $cfg = self::weapons();
        $weapon = $loadout['weapon'] ?? 'mk18';
        if (!isset($cfg['weapons'][$weapon]) || $cfg['weapons'][$weapon]['minLevel'] > $level) {
            $weapon = 'mk18';
        }
        $out = ['weapon' => $weapon, 'camo' => 'default', 'attachments' => []];

        foreach ($cfg['camos'] as $camo) {
            if ($camo['id'] === ($loadout['camo'] ?? 'default') && $camo['minLevel'] <= $level) {
                $out['camo'] = $camo['id'];
            }
        }
        // Le Gunsmith (accessoires) n'est accessible qu'a partir du niveau 5.
        if ($level >= 5) {
            foreach ($cfg['slots'] as $slot) {
                $want = $loadout['attachments'][$slot] ?? '';
                foreach ($cfg['attachments'][$slot] ?? [] as $att) {
                    if ($att['id'] === $want && $att['minLevel'] <= $level) {
                        $out['attachments'][$slot] = $att['id'];
                    }
                }
            }
        }
        return $out;
    }

    private static function load(string $rel): array
    {
        $path = self::root() . '/' . $rel;
        $raw = @file_get_contents($path);
        if ($raw === false) {
            throw new \RuntimeException("Configuration introuvable: {$rel}");
        }
        return json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
    }
}
