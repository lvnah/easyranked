# EasyRanked — FPS compétitif navigateur

FPS multijoueur temps réel qui tourne dans un onglet : rendu **WebGL2 / Three.js**,
serveur autoritaire **PHP 8 + Ratchet**, persistance **SQLite**.

**Tous les modèles 3D et toutes les textures sont générés par le code** — opérateurs
tactiques, armes, accessoires, arène, matériaux PBR. Le dépôt ne contient aucun
asset (ni `.glb`, ni `.fbx`, ni image) en dehors de la bibliothèque Three.js.

---

## 1. Démarrage

```bash
composer install
```

```bash
php -S 0.0.0.0:8080 -t public public/router.php
```

```bash
php server/server.php --port=8081 --tick=40
```

Puis ouvrir <http://localhost:8080>.

Le premier serveur sert le client et l'API REST ; le second porte le temps réel.
La base SQLite est créée et migrée toute seule au premier lancement
(`data/easyranked.sqlite`).

Le mode **entraînement contre des bots fonctionne sans le serveur WebSocket** :
la simulation tourne alors entièrement dans le navigateur.

### Options du serveur temps réel

| Option | Défaut | Rôle |
|---|---|---|
| `--port` / `ER_PORT` | `8081` | Port d'écoute |
| `--host` / `ER_HOST` | `0.0.0.0` | Interface |
| `--tick` / `ER_TICKRATE` | `40` | Tickrate, borné à 20–60 Hz |

### Production (hébergement mutualisé : AlwaysData, o2switch, OVH…)

Trois points, et un seul compte vraiment :

**1. La racine du site doit pointer sur `public/`, pas sur la racine du projet.**
Téléverse **tout** le projet (y compris `shared/`, `server/` et `vendor/`), puis
règle le répertoire racine du site sur le sous-dossier `public`. Les dossiers
`shared/` et `server/` doivent rester *à côté* de `public/`, jamais dedans : c'est
ce qui les met hors de portée du web tout en laissant PHP les lire.

```
~/www/easyranked/
├── public/      ← racine du site
├── shared/
├── server/
├── vendor/
└── data/        ← doit être accessible en écriture (SQLite)
```

**2. Le type de site doit être « PHP », pas « Programme utilisateur ».**
Le site, c'est l'API REST et les fichiers statiques : du PHP classique. Le serveur
WebSocket est un processus **séparé**, ce n'est pas le backend du site, et il lui
faut son propre site sur un sous-domaine (voir plus bas). Si le site du jeu pointe
vers un programme — qui n'écoute pas, ou pas sur l'interface attendue — le frontal
HTTP de l'hébergeur répond *« Connection to upstream failed »* : il n'a trouvé
personne au bout.

Il faut donc **deux sites** :

| Adresse | Type | Configuration |
|---|---|---|
| `mondomaine.tld` | PHP | racine : `easyranked/public` |
| `ws.mondomaine.tld` | Programme utilisateur | commande : `php server/server.php`, répertoire de travail : `easyranked/` |

Le premier suffit à jouer (entraînement contre bots). Le second ajoute le
multijoueur temps réel.

**3. Aucune réécriture d'URL n'est nécessaire.** Le client appelle
`api/index.php?r=<route>` et `api/shared.php?f=<fichier>`, qui fonctionnent sous
Apache comme sous nginx, et depuis n'importe quel sous-répertoire.
`public/.htaccess` n'ajoute que des routes plus lisibles (`/api/login`) et de la
compression : s'il est ignoré, le jeu fonctionne quand même.

#### Le multijoueur temps réel

`server/server.php` est un démon qui doit tourner en permanence. Sans lui, **le
jeu reste jouable** : le mode entraînement contre bots tourne entièrement dans le
navigateur. Seule la case « Multijoueur temps réel » du lobby devient inopérante.

Il lui faut donc **son propre site**, distinct de celui du jeu : type
« programme utilisateur », sur un sous-domaine dédié (`ws.mondomaine.tld`).

```
Type                  Programme utilisateur
Commande              php server/server.php
Répertoire de travail easyranked/
```

`server.php` lit l'adresse et le port que l'hébergeur lui impose, dans cet ordre
de priorité :

1. `--host` / `--port` en ligne de commande ;
2. **`IP` et `PORT`** — les variables posées par AlwaysData, Heroku, Scalingo,
   Clever Cloud… ;
3. `ER_HOST` / `ER_PORT`, propres au projet ;
4. `0.0.0.0:8081` par défaut, pour un poste de développement.

Aucun argument n'est donc nécessaire : le programme se place tout seul sur la
bonne interface. AlwaysData impose une adresse **IPv6** (`::` ou la valeur de
`IP`) et un port fixe (`PORT`) ; écouter sur `0.0.0.0` ne suffit pas, le frontal
ne trouverait personne et répondrait « Connection to upstream failed ».

Deux pièges à vérifier avant de chercher ailleurs :

- **`vendor/` doit exister sur le serveur.** Il n'est pas versionné : si le
  dossier manque, `server.php` s'arrête dès le démarrage et l'hébergeur répond,
  là encore, « Connection to upstream failed ». Lance `composer install` en SSH
  à la racine du projet, ou téléverse `vendor/` depuis ton poste.
- **Un site en HTTPS exige `wss://`.** Un navigateur refuse une connexion
  `ws://` non chiffrée depuis une page sécurisée. Renseigne
  `wss://ws.mondomaine.tld` dans le champ serveur du lobby.

Ouvrir l'adresse du WebSocket dans un navigateur affiche une erreur : c'est
normal, ce service ne répond qu'aux requêtes d'upgrade WebSocket.

### Production (Apache / nginx auto-hébergé)

`public/` est la racine web. `public/.htaccess` ajoute les routes lisibles et la
compression. Derrière nginx, il faut un `proxy_pass` avec `Upgrade`/`Connection`
vers le port du serveur temps réel pour le WebSocket.

---

## 2. Arborescence

```
easyranked/
├── composer.json
├── shared/                     ← source unique de vérité, lue par PHP *et* par JS
│   ├── arena.json              ← géométrie, spawns, waypoints de l'arène
│   └── weapons.json            ← armes, accessoires, camos, équilibrage, modes
├── tools/
│   └── gen_arena.mjs           ← générateur déterministe de shared/arena.json
├── server/
│   ├── server.php              ← point d'entrée WebSocket (Ratchet)
│   ├── bootstrap.php           ← autoload (Composer ou repli PSR-4)
│   ├── schema.sql              ← schéma SQLite
│   └── src/
│       ├── Config.php          ← chargement de shared/*, résolution des armes
│       ├── Database.php        ← PDO + migration idempotente
│       ├── Auth.php            ← comptes, jetons, classes
│       ├── Progression.php     ← courbe d'XP, niveaux 1→100, statistiques
│       ├── Ballistics.php      ← raycast autoritaire, hitboxes, chute de dégâts
│       ├── Navigation.php      ← graphe de waypoints + A*
│       ├── PlayerState.php     ← état d'un combattant + historique (lag comp.)
│       ├── Bot.php             ← IA serveur (perception / décision / tir)
│       ├── Room.php            ← une partie : tirs, score, respawns, XP
│       └── GameServer.php      ← matchmaking, salles, boucle de tick
└── public/
    ├── index.html
    ├── router.php              ← routeur du serveur PHP de développement
    ├── .htaccess
    ├── api/index.php           ← API REST
    ├── css/style.css
    ├── vendor/three.module.js  ← Three.js r160.1 (MIT), vendorisé
    └── js/
        ├── main.js             ← assemblage + boucle de jeu
        ├── engine.js           ← renderer, lumières, ombres, pools d'effets
        ├── textures.js         ← textures PBR procédurales
        ├── geo.js              ← primitives + fusion par matériau
        ├── visuals.js          ← opérateurs, armes, accessoires, props
        ├── avatars.js          ← avatars distants + animation procédurale
        ├── arena.js            ← construction de l'arène + colliders
        ├── physics.js          ← collisions capsule/AABB, raycast, hitboxes
        ├── player.js           ← contrôleur (déplacement, glissade) + entrées
        ├── weapons.js          ← arme 1ʳᵉ personne (recul, ADS, animations)
        ├── hud.js              ← interface de combat
        ├── net.js              ← client WebSocket + interpolation
        ├── bots.js             ← partie hors ligne + IA client
        └── lobby.js            ← lobby, progression, atelier Gunsmith 3D
```

---

## 3. Base de données

| Table | Contenu |
|---|---|
| `users` | pseudo, hash du mot de passe, jeton de session + expiration |
| `progression` | niveau, XP, éliminations, morts, tirs à la tête, dégâts, parties, victoires, meilleure série, temps de jeu |
| `loadouts` | 5 classes par joueur : arme, 7 slots d'accessoires, camouflage |
| `matches` / `match_players` | historique des parties et performances individuelles |

La courbe d'XP (`Progression::xpForNext`) monte de ~900 XP au niveau 1 à
~29 000 XP au niveau 99 ; le Gunsmith se débloque au **niveau 5**.

---

## 4. Modélisation 3D procédurale

### Opérateur — `buildDetailedArmoredCharacter()`

**1,83 m, ~130 primitives, fusionnées en ~68 meshes.** Les volumes sont assemblés
à partir de capsules, cylindres, boîtes et sphères, puis fusionnés par matériau
tout en conservant la hiérarchie d'articulations nécessaire à l'animation.

- jambes épaisses, bottes de combat à semelle crantée et lacets ;
- genouillères en relief (coque sphérique + rembourrage + deux sangles) ;
- pantalon et veste amples : chaque segment combine une capsule *et* un
  sur-cylindre, précisément pour éviter l'effet « fil de fer » ;
- gilet pare-balles volumineux : plaques avant/arrière en relief, cummerbund
  latéral, bretelles, **trois porte-chargeurs frontaux saillants**, poches
  utilitaires, radio et antenne, deux grenades accrochées ;
- casque lourd arrondi (coque + couronne), couvre-oreilles, micro-perche,
  rails latéraux, **module de vision nocturne double** (platine, bras articulé,
  deux tubes avec objectifs et pare-soleil) ;
- visière/masque translucide, gants épais à dos renforcé et doigts groupés.

Le rig exposé (`userData.rig`) couvre hanches, buste, tête, gilet, bras et jambes ;
`avatars.js` l'anime : cycle de marche, accroupissement, posture de tir,
recul, rechargement, chute à la mort.

### Arme — `buildDetailedWeapon()`

Quatre morphologies (`carbine`, `smg`, `ak`, `dmr`), de 0,60 m à 0,99 m.

- boîtier de culasse épais (bloc + dessous cylindrique + capot) ;
- **rail Picatinny à vraies dents** (`picatinny()`), pas une texture ;
- garde-main octogonal à fentes M-LOK, ou garde-main AK à évents ;
- canon étagé, bloc de gaz, guidon rabattable ;
- **chargeur réellement courbe** : 4–5 segments successivement inclinés, avec
  nervures, plancher et cartouche visible ;
- poignée ergonomique inclinée, pontet, détente, sélecteur, levier d'armement,
  fenêtre d'éjection.

### Accessoires — `buildAttachment()`

Chaque accessoire est un volume 3D greffé sur un *socket* précis
(`optic`, `barrel`, `muzzle`, `stock`, `laser`, `grip`, `mag`) :

| Slot | Pièces |
|---|---|
| Optique | point rouge (tube + lentilles + point émissif), holographique, lunette 3.4× (cloche, pare-soleil, tourelles, réticule) |
| Bouche | compensateur à ports, silencieux à chicanes, frein de bouche |
| Canon | canon long cannelé, canon court CQB (déplace le socket de bouche) |
| Crosse | tactique massive (appui-joue, plaque, monopode), squelette ajourée |
| Laser | boîtier + émetteur + **faisceau qui s'arrête au premier obstacle** |
| Poignée | verticale annelée, inclinée |
| Chargeur | étendu (chargeur reconstruit 38 % plus long), chargeurs rapides |

Monter une optique recalcule la hauteur de l'organe de visée, donc la pose d'ADS.

---

## 5. Gameplay

**Déplacements** — `ZQSD`, `Espace` saut, `Maj` sprint, `C`/`Ctrl` accroupi,
`Maj + C` en course : **glissade**. La glissade conserve l'inertie (vitesse
acquise × 1,22, plafonnée à 9,6 m/s), s'amortit, abaisse la capsule à 1,02 m et
fait franchement plonger la caméra. Vitesses : marche 4,7 · sprint 7,4 ·
accroupi 2,7 m/s, modulées par la mobilité de l'arme.

**Combat** — 150 points effectifs, répartis en **100 PV + 50 de bouclier** : le
bouclier absorbe en premier et revient plus vite (3,2 s d'attente, 26/s) que la
vie (5 s, 22/s), ce qui donne deux barres distinctes dans le HUD comme sur la
référence. Multiplicateur tête ×1,85, membres ×0,82. Six hitboxes (tête
sphérique, poitrine, ventre, deux bras latéraux, jambes), **identiques côté
client et côté serveur**.

Nombre de balles calculé sur les 150 points effectifs :

| Arme | Dégâts torse | Balles | TTK | Tête |
|---|---|---|---|---|
| MP5-K | 22 | 7 | 0,41 s | 4 |
| MK18 | 26 | 6 | 0,39 s | 4 |
| AK-74M | 30 | 5 | 0,39 s | 3 |
| MK12 SPR | 55 | 3 | 0,40 s | 2 |

**Recul** — composante verticale croissante puis saturée, composante horizontale
suivant un motif reproductible (donc maîtrisable), retour élastique au centre.
Le viseur dynamique traduit la dispersion réelle en pixels à partir du champ de
vision : l'écart des branches *est* la zone d'impact.

**Modes** — 1v1 (15 élim.), 2v2 (30), 3v3 (45), 4v4 (60). Les bots complètent
les équipes incomplètes ; cinq niveaux de difficulté, de Recrue à Élite.

---

## 6. Architecture réseau

Le serveur est **autoritaire** : il rejoue chaque tir contre sa propre copie du
monde et contre les positions qu'il connaît, avec **compensation de lag** (jusqu'à
250 ms de rembobinage dans un historique de ~0,6 s). Le client prédit son propre
déplacement, interpole les autres joueurs avec ~2 ticks de retard, et reçoit du
serveur la vie, les munitions et le score.

Un contrôle de vitesse borne les déplacements à 1,9× la vitesse théorique ; au-delà
le joueur est recalé (au plus 5 recalages par seconde).

Protocole JSON compact — snapshots en tableaux positionnels :

```
hello / welcome · input · shoot · reload · nade · chat · leave
snap { k, now, p[], e[], score, state, left }
```

---

## 7. Performance

| Choix | Effet |
|---|---|
| Aucun post-traitement | économise une passe plein écran |
| Shadow map unique, frustum glissant de 26 m autour du joueur | beaucoup plus de texels par mètre qu'une carte couvrant 84×64 m |
| Fusion par matériau | ~40 murs de brique → 1 appel de rendu |
| `InstancedMesh` pour caisses, fûts, palettes, débris | 210 props en quelques appels |
| `matrixAutoUpdate = false` sur les décors | plus de recalcul de matrices statiques |
| Pools pré-alloués (impacts, traceuses, flashs, particules) | zéro allocation en combat |
| Résolution adaptative | le `devicePixelRatio` baisse sous 55 FPS, remonte au-dessus de 140 |

`F3` affiche FPS, appels de rendu, triangles, résolution interne et ping.

Côté serveur, le tick est journalisé toutes les 15 s. Mesuré sur une salle 2v2
avec trois bots : **0,33 ms de tick moyen, 2,36 ms au pire**, pour un budget de
25 ms à 40 Hz — soit environ 1,3 % du budget utilisé.

---

## 8. Tests

```bash
npm install
```

```bash
node tools/test_movement.mjs
```

Simule le contrôleur sur un sol plat, sans navigateur ni GPU, et vérifie les
vitesses (marche / sprint / visée / accroupi), le déclenchement et la durée de
la glissade, la plongée de caméra, la hauteur de saut et le temps de montée en
visée. C'est ce test qui a révélé que le sprint plafonnait à 4,87 m/s au lieu de
7,4 : le modèle additif `v += a·dt ; v *= 1 − f·dt` borne la vitesse à `a/f`,
valeur inférieure à la cible **et dépendante du pas de temps**. Le contrôleur
converge désormais exponentiellement vers la vitesse visée.

`npm install` ne sert qu'aux outils : le jeu lui-même n'a aucune dépendance npm.

---

## 9. Régénérer l'arène

```bash
node tools/gen_arena.mjs
```

Le générateur place les volumes, puis **dérive** le graphe de navigation : grille
de 4,5 m filtrée contre les solides, arêtes reliées par test de visibilité,
élagage à la plus grande composante connexe, et spawns choisis dans ce graphe —
ce qui garantit qu'aucun point d'apparition n'est isolé.

---

## 10. Licence

Code du projet : MIT. `public/vendor/three.module.js` est Three.js r160.1,
distribué sous licence MIT (voir `public/vendor/three.LICENSE`).
