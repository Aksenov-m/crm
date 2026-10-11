"""Store an OpenAI key without displaying it or putting it in shell history."""
import getpass
import os
from pathlib import Path
import re

env_file = Path(__file__).resolve().parents[1] / ".env.images"
if not env_file.is_file():
    raise SystemExit("Missing .env.images; initialize the image service first.")
key = getpass.getpass("OpenAI API key (hidden): ").strip()
if not re.fullmatch(r"sk-[A-Za-z0-9_-]+", key):
    raise SystemExit("Invalid key format. Configuration was not changed.")
lines = [line for line in env_file.read_text().splitlines() if not line.startswith("OPENAI_API_KEY=")]
lines.append("OPENAI_API_KEY=" + key)
# Open the existing private file without creating an intermediate readable copy.
os.chmod(env_file, 0o600)
with env_file.open("w") as output:
    output.write("\n".join(lines) + "\n")
print("Key saved. Restart the image-worker container to apply it.")
