Rôle
Quelles sont les catégories d’utilisateurs amenées à utiliser la plateforme ?
Administrateur
Opérateur Havet
Client
Spécificité fonctionnelle par rôle
Rôle Opérateur Havet
US-001 : En tant qu’opérateur Havet, je peux voir les demandes de chatbot.
US-002 : En tant qu’opérateur Havet, je peux modifier le statut d’une demande.
Règles métier associées :
Statuts disponibles : A traité, En cours de traitement, En attente d’élément, Livré, A reprendre.
Une demande déjà en cours de traitement ou dans un statut ultérieur ne peut plus être traitée par un autre opérateur Havet, sauf si un administrateur ou l’opérateur en charge passe le statut en à « A reprendre».
Un status passer en “À reprendre” doit toujours être accompagné de motif
Le statut d’une demande déjà livrée ne doit plus être modifiable.
Une demande ne peut être marquée comme livrée que si un moyen d’intégration est défini :
Lien public
Code Widget
Lien d’accès à l’API
US-003 : En tant qu’opérateur Havet, je peux créer des chatbots.
US-004 : En tant qu’opérateur Havet, je peux modifier des chatbots.
Règle métier associée :
Un opérateur Havet ne peut pas modifier un chatbot en cours de traitement par un autre opérateur.
US-005 : En tant qu’opérateur Havet, je peux publier un chatbot.
Règle métier associée :
Un chatbot publié doit disposer d’un moyen d’intégration : lien public d’accès, code d’intégration ou chemin d’API.

US-006 : En tant qu’opérateur Havet, je peux voir les demandes de support.
Règles métier associées :
Une demande de support doit être rattachée à un chatbot existant.
Une demande de support doit être rattachée à un client existant.
Une demande de support déjà en cours de traitement ne peut plus être traitée par un autre opérateur Havet que si son statut est repassé à « A reprendre» par l’administrateur.
Un tâche de support passer à “A reprendre” doit toujours être accompagner de motif
US-007 : En tant qu’opérateur Havet, je peux modifier les statuts des demandes de support.
Règles métier associées :
Statuts disponibles : Nouveau, A traité,A reprendre,  En cours de traitement, Résolu, Fermé.
Les opérateurs Havet ne peuvent pas voir les demandes ayant le statut « Nouveau ».
US-008 : En tant qu’opérateur Havet, je peux lister les chatbots.
US-009 : En tant qu’opérateur Havet, je peux interagir avec le client : (clé d’API, document, spécificité).
Règle métier :
Les interactions doivent être rattachées à une demande de chatbot ou une demande de support.


Rôle Administrateur
US-001 : En tant qu’administrateur, je peux faire tout ce qu’un opérateur Havet peut faire.
Règles métier associées :
Un administrateur peut repasser une demande de chatbot déjà traitée en « A traité ».
Un administrateur peut passer une demande de support déjà traitée en « A traité ».
Un administrateur peut voir les demandes de chatbot au statut « Nouveau ».
US-002 : En tant qu’administrateur, je peux passer les nouvelles demandes en « A traité ».
US-003 : En tant qu’administrateur, je peux supprimer des chatbots.
US-004 : En tant qu’administrateur, je peux voir les KPI clés :
Nombre de demandes A traitées
Nombre de demandes En cours de traitement
Nombre de demandes Livrées
Nombre de chatbots résiliés
Nombre de demandes de support non traitées
Durée de support
US-005 : En tant qu’administrateur, je peux voir quel opérateur traite une demande.
US-006 : En tant qu’administrateur, je peux mettre un chatbot en pause.
Règle métier associés:
Un chatbot en pause ne devrait pas être utilisable (ne répond pas).
US-007 : En tant qu’administrateur, je peux voir les demandes de résiliation.
US-008 : En tant qu’administrateur, je peux voir les mises en pause de chatbot.
US-009:  En tant qu’administrateur, je peux inviter des clients à rejoindre Madatalk


Rôle Client
US-001 : En tant que client, je peux faire une demande de chatbot.
Règle métier associée :
Une demande de chatbot doit avoir au moins une description.
US-002 : En tant que client, je peux faire une demande de support.
Règle métier associée :
Une demande de support doit toujours être rattachée à un chatbot existant.
US-003 : En tant que client, je peux voir mes chatbots.
US-004 : En tant que client, je peux résilier un chatbot.
US-005 : En tant que client, je peux mettre un chatbot en Pause.


