# Images for the OPSLOG demo stack (staging only, synthetic data). Targets: api, web, landing.
#   docker build -f deploy/Dockerfile --target api -t opslog-api .
#   docker build -f deploy/Dockerfile --target web -t opslog-web \
#     --build-arg VITE_OIDC_DOMAIN=https://<prefix>.auth.<region>.amazoncognito.com --build-arg VITE_OIDC_CLIENT_ID=<client id> .
# NODE_ENV is deliberately not set to production: the staging guard refuses to start under it.

FROM node:22-bookworm-slim AS build
# Optional build secret `extra-ca`: a CA bundle for builds behind a TLS-inspecting proxy
# (docker build --secret id=extra-ca,src=ca.pem ...). Normal builds do not pass it.
RUN --mount=type=secret,id=extra-ca,required=false \
    if [ -f /run/secrets/extra-ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra-ca; fi; \
    npm install --global pnpm@11.25.0
WORKDIR /repo
COPY . .
RUN --mount=type=secret,id=extra-ca,required=false \
    if [ -f /run/secrets/extra-ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra-ca; fi; \
    pnpm install --frozen-lockfile
# Public identity-provider settings baked into the web bundle (no secret): hosted UI domain and client id.
ARG VITE_OIDC_DOMAIN=""
ARG VITE_OIDC_CLIENT_ID=""
ENV VITE_OIDC_DOMAIN=$VITE_OIDC_DOMAIN VITE_OIDC_CLIENT_ID=$VITE_OIDC_CLIENT_ID
RUN node apps/api/server/build.mjs && node apps/web/build.mjs && node apps/landing/build.mjs

FROM node:22-bookworm-slim AS api
WORKDIR /app
COPY --from=build /repo/apps/api/server/bundle/server.mjs ./server.mjs
# The one-shot job of docker-compose.yml (`migrate` service) runs the same image: node migrate.mjs.
COPY --from=build /repo/apps/api/server/bundle/migrate.mjs ./migrate.mjs
USER node
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "server.mjs"]

# The `backup` service of docker-compose.yml: MySQL's own client tools (same major version as the
# server, so mysqldump and mysqlbinlog read its logs) plus the scripts of infra/operations. It holds
# the backup account's password and nothing else; OPSLOG_PII_MASTER_KEY is never given to it.
FROM mysql:8.4 AS backup
USER root
COPY infra/operations/lib /opt/opslog-ops/lib
COPY infra/operations/backup /opt/opslog-ops/backup
RUN chmod +x /opt/opslog-ops/backup/*.sh \
 && for tool in bash gzip sha256sum stat mysql mysqldump mysqlbinlog; do command -v "$tool" >/dev/null || echo "warning: missing $tool in the backup image" >&2; done
ENV OPSLOG_BACKUP_DIR=/backups
VOLUME ["/backups"]
HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 \
  CMD ["/opt/opslog-ops/backup/backup.sh", "health"]
ENTRYPOINT ["/opt/opslog-ops/backup/entrypoint.sh"]

FROM nginx:1.27-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist-web /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1/healthz"]

# Public sales page with the demo-request form; requests are appended to /data (a volume).
FROM node:22-bookworm-slim AS landing
WORKDIR /app
COPY --from=build /repo/apps/landing/bundle/landing.mjs ./landing.mjs
COPY apps/landing/public ./public
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
ENV PORT=8090
EXPOSE 8090
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "landing.mjs"]
