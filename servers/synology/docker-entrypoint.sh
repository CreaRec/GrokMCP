#!/bin/sh
set -e

echo "Running Prisma migrations..."
npx prisma migrate deploy

echo "Migrations complete. Starting server..."
exec node dist/http.js
