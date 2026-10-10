#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

readonly PUBLIC_KEY_FILE="/tmp/crm-github-deploy.pub"
readonly RECEIVER_FILE="/tmp/crm-github-deploy.sh"
readonly DEPLOY_USER="crmdeploy"
readonly RECEIVER_PATH="/usr/local/sbin/crm-github-deploy"

if [[ ! -s "$PUBLIC_KEY_FILE" || ! -s "$RECEIVER_FILE" ]]; then
  echo "The deploy public key or receiver script is missing from /tmp." >&2
  exit 1
fi

command -v ssh-keygen >/dev/null
command -v visudo >/dev/null
ssh-keygen -lf "$PUBLIC_KEY_FILE" >/dev/null
dnf install -y rsync

if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$DEPLOY_USER"
fi
passwd --lock "$DEPLOY_USER" >/dev/null
install -o root -g root -m 0755 "$RECEIVER_FILE" "$RECEIVER_PATH"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0700 "/home/$DEPLOY_USER/.ssh"

read -r key_type key_data _ < "$PUBLIC_KEY_FILE"
authorized_keys="/home/$DEPLOY_USER/.ssh/authorized_keys"
touch "$authorized_keys"
if ! grep -Fq "$key_data" "$authorized_keys"; then
  printf 'command="sudo -n %s",restrict,no-user-rc %s %s github-actions-proaksenov-crm\n' \
    "$RECEIVER_PATH" "$key_type" "$key_data" >> "$authorized_keys"
fi
chown "$DEPLOY_USER:$DEPLOY_USER" "$authorized_keys"
chmod 0600 "$authorized_keys"

printf '%s ALL=(root) NOPASSWD: %s ""\n' "$DEPLOY_USER" "$RECEIVER_PATH" \
  > /etc/sudoers.d/crmdeploy
chmod 0440 /etc/sudoers.d/crmdeploy
visudo -cf /etc/sudoers.d/crmdeploy

chown root:root /opt/prolot-crm
chmod 0755 /opt/prolot-crm
if command -v restorecon >/dev/null 2>&1; then
  restorecon -RF "/home/$DEPLOY_USER/.ssh" "$RECEIVER_PATH" /etc/sudoers.d/crmdeploy
fi

rm -f -- "$PUBLIC_KEY_FILE" "$RECEIVER_FILE"
echo "GitHub deploy account is ready. SSH key is restricted to the deployment command."
