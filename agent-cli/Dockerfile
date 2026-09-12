# A hosted agent with no USB port: Ledger's CLI, a headless secret store, and tor-agent.
# It holds only ciphertext plus the Key Ring membership that `tor-agent enroll` provisions from a Mac.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates dbus-x11 gnome-keyring libsecret-tools \
  && rm -rf /var/lib/apt/lists/*
# The keychain library ships its native binary as an optional dependency, so install it whole, globally.
# The Ledger device kits are not installed here: this host has no USB port and never signs.
RUN npm install -g @ledgerhq/wallet-cli@2.1.0 @napi-rs/keyring@1.1.3 --no-audit --no-fund

WORKDIR /app
# Only the CLI's own code: a copied node_modules would carry the wrong platform's native binaries.
COPY agent-cli/package.json /app/agent-cli/package.json
COPY agent-cli/bin /app/agent-cli/bin
COPY agent-cli/src /app/agent-cli/src
COPY agent-cli/docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh /app/agent-cli/bin/tor-agent.mjs && ln -s /app/agent-cli/bin/tor-agent.mjs /usr/local/bin/tor-agent

ENV DBUS_SESSION_BUS_ADDRESS="unix:path=/run/dbus.sock" \
    NODE_PATH="/usr/local/lib/node_modules"
ENTRYPOINT ["/entrypoint.sh"]
CMD ["sleep", "infinity"]
