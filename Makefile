.PHONY: up down logs migrate seed test

up:
	docker compose -f infra/docker-compose.yml up -d --build

down:
	docker compose -f infra/docker-compose.yml down

logs:
	docker compose -f infra/docker-compose.yml logs -f --tail=200

migrate:
	docker compose -f infra/docker-compose.yml exec api python -m app.db.migrate_cli

seed:
	docker compose -f infra/docker-compose.yml exec api python -m app.db.seed

test:
	docker compose -f infra/docker-compose.yml exec api pytest -q
