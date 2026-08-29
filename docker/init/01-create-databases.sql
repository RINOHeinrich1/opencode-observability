-- Deuxième base : panneau (users / sessions / archives).
-- La première base (task_registry) est créée par la variable POSTGRES_DB.
-- Exécuté uniquement au premier démarrage (répertoire /docker-entrypoint-initdb.d).
CREATE DATABASE panel;
