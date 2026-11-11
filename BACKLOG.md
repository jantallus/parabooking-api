# Backlog Parabooking

Évolutions envisagées, idées et bugs repérés. Chaque entrée dit **pourquoi** on la ferait, **ce dont elle dépend** et **où on en est**, pour pouvoir la reprendre plus tard sans tout redécouvrir.

États : `idée` (à creuser) · `prêt` (décidé, peut être développé) · `en attente` (bloqué par quelqu'un d'autre) · `en cours` · `fait` · `abandonné`

Ajouter une entrée : la mettre dans la bonne section, avec au minimum un titre, un état et une ligne « Pourquoi ».

---

## Bugs repérés

### Email admin décalé pour les réservations gratuites
- **État :** prêt
- **Pourquoi :** pour une réservation à 0 € (partenaire, ou bon cadeau qui couvre tout le prix), l'email « Nouvelle réservation » envoyé aux admins affiche les informations dans les mauvaises cases : le nom du vol à la place de l'email, la date à la place du vol, l'heure à la place de la date.
- **Où :** `routes/public.js`, appel à `sendAdminNotificationEmail` dans `/api/public/checkout` (branche `finalPriceCents === 0`). Il manque l'argument email : la fonction attend `(nom, téléphone, email, vol, date, heure, nombre…)`.
- **Effort :** quelques minutes.

---

## Office du Tourisme de La Clusaz (Feratel Deskline)

Contexte complet dans la note de préparation de réunion (artifact « Aravis Parapente × Feratel »). Problème actuel : quand un vol est vendu chez Fluide ou Aravis sur un horaire aussi vendu par l'OT, on oublie régulièrement de réduire la place dans Deskline, et l'OT revend un créneau déjà pris.

### Lecture automatique des emails de la Centrale
- **État :** prêt (à lancer après la réunion avec l'OT)
- **Pourquoi :** plus de saisie manuelle des ventes OT, plus de notification ratée sur le terrain, et une double réservation détectée dans la minute.
- **Principe :** un filtre Gmail transfère les emails de `reservation.laclusaz.com@feratel.tv` vers une adresse lue par Parabooking. Parabooking vérifie la signature DKIM `feratel.tv`, lit le PDF joint (référence, date, produit, heure de début, passager, poids, prix net), puis bloque le créneau avec le partenaire OT. Les annulations (« remplace les confirmations n° X ») libèrent le créneau grâce à la référence, car l'heure n'y figure pas. En cas de conflit ou d'email illisible, il envoie une alerte aux admins.
- **À préciser :**
  - correspondance entre les produits Deskline et les vols Aravis (le suffixe entre parenthèses varie : « ARAVISPARA », « SF ») ;
  - un exemple de réservation à plusieurs passagers ;
  - le choix du moniteur ;
  - libération automatique ou simple alerte à l'annulation.
- **Dépend de :** un service de réception d'emails (Brevo inbound à vérifier, sinon Mailgun ou Postmark) et un partenaire « Office du Tourisme » facturable dans Parabooking.

### Alerte « réduire de 1 » dans Deskline
- **État :** prêt
- **Pourquoi :** c'est la cause principale des doubles réservations. Supprime l'oubli humain.
- **Principe :** toutes les 2 minutes, Parabooking repère les nouvelles réservations, tous canaux confondus, qui chevauchent un vol OT. Il envoie alors un email à Julien et Sam : « Deskline : <produit>, <heure> le <date> → réduire de 1 ». Optionnellement, il envoie « augmenter de 1 » lors d'une annulation. Les réservations venant de l'OT sont exclues.
- **Produits OT :**

  | Produit | Heure | Saison |
  |---|---|---|
  | Merle enfant (Découverte ou Loupiot) | 9h25 | été |
  | Plaisir 15 min | 11h00 | été |
  | Performance (Ascendance) 30 min | 13h10 | été |
  | Beauregard | 11h00 | hiver |
  | Crêt du Loup | 11h40 | hiver |

- **À préciser :**
  - la durée des vols Merle, Beauregard et Loup ;
  - si tous les moniteurs comptent ;
  - les mois de chaque saison ;
  - l'email d'annulation.
- **Dépend de :** une variable Railway avec les emails destinataires.

### API de disponibilité Feratel (mise à jour automatique de Deskline)
- **État :** en attente (réponse de Feratel)
- **Pourquoi :** transformerait l'alerte « réduire de 1 » en mise à jour automatique, et permettrait d'ouvrir toutes nos heures à l'OT.
- **Question à poser :** existe-t-il une API pour régler les places d'un service additionnel par date et heure de départ (l'équivalent de « Maintenance période > Régler la disponibilité à »), et est-elle incluse dans l'abonnement actuel ? Identifiant de notre service : `18b92642-20c0-4f83-ad21-e732ee7a50c8`.
- **Décision :** à ne faire que si c'est gratuit ou très peu cher. La commission et l'inscription annuelle versées à l'OT pèsent déjà.

### Partenariat d'interface Feratel (Deskline consulte Parabooking)
- **État :** abandonné
- **Pourquoi abandonné :** c'est le modèle bookingkit, pensé pour un éditeur qui apporte de nombreux prestataires. Disproportionné pour notre taille, et coût probable.

---

## Partenaires et API

### Takamaka : mise en service
- **État :** en attente (développeur Takamaka)
- **Fait :** endpoints `GET /api/public/takamaka/slots` et `POST /api/public/takamaka/book` en production, testés le 10/11/2026. Partenaire `TAKA2027`. Deck développeur à jour.
- **Reste :**
  - transmettre la clé API au développeur ;
  - vérifier les réglages « à facturer » et « facturé par » de `TAKA2027` ;
  - libérer le créneau de test du 08/02/2027 à 11h40 s'il ne l'est pas encore.

### Blocage temporaire pendant le paiement partenaire
- **État :** idée
- **Pourquoi :** éviter qu'un créneau soit pris entre le choix du client et la fin de son paiement chez le partenaire (réponse 409).
- **Principe :** un appel « réserver temporairement » qui retient le créneau 10 à 15 min, confirmé ensuite par `POST /book`.
- **Décision :** pas pour l'instant, le volume est trop faible pour que le conflit arrive. À reconsidérer si des 409 apparaissent.

### Limiter les horaires vendables par un partenaire
- **État :** idée
- **Pourquoi :** Takamaka ne vend que 11h40 et 12h20, mais l'API leur permet de bloquer n'importe quel horaire Beauregard.
- **Principe :** une liste d'horaires autorisés par partenaire. Environ 5 minutes de développement.

### Autoriser un appel navigateur (CORS) pour un partenaire
- **État :** idée
- **Pourquoi :** seulement si le développeur d'un partenaire appelle `GET /slots` en JavaScript depuis le navigateur (par exemple `annecy.takamaka.fr`).
- **Où :** liste des origines autorisées dans `app.js`.

### Compatibilité avec le standard OCTO
- **État :** idée (garder dans un coin)
- **Pourquoi :** OCTO (octo.travel) est un standard ouvert pour publier des disponibilités d'activités en temps réel et recevoir des réservations. Être compatible permettrait de se brancher à tout système qui le parle.
- **Constat (novembre 2026) :** utilisé surtout par des revendeurs internationaux et des logiciels de billetterie (Tiqets, Headout, Ventrata, Peek…). Aucun signe que Feratel le supporte. Ouvrirait surtout des canaux à commission.
- **Quand y revenir :** si un canal qui nous intéresse parle OCTO, ou si Parabooking est proposé à d'autres écoles de parapente (ce serait alors un argument de vente).
- **Effort estimé :** quelques jours. La base existe avec l'API Takamaka.
