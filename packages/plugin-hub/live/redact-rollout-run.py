"""Sanitize local and optional remote machine identifiers in run records."""
import getpass
import os
from pathlib import Path
import socket
import subprocess
import sys

replacements = [(str(Path.home()), '<home>'), (getpass.getuser(), '<user>'), (socket.gethostname(), '<host>'), (socket.gethostname().split('.')[0], '<host>')]
target = os.environ.get('HUB_BOX')
if target:
    replacements.append((target, '<host>'))
    replacements.append((target.rsplit('@', 1)[-1], '<host>'))
    result = subprocess.run(['ssh', target, 'printf "%s\\n" "$HOME" "$USER"; hostname'], capture_output=True, text=True, check=True)
    fields = result.stdout.strip().splitlines()
    replacements.extend(zip(fields, ['<home>', '<user>', '<host>']))
    for host in fields[2:]:
        replacements.append((host.split('.')[0], '<host>'))
for name in sys.argv[1:]:
    path = Path(name)
    text = path.read_text()
    for source, replacement in sorted(replacements, key=lambda pair: -len(pair[0])):
        if source:
            text = text.replace(source, replacement)
    path.write_text(text)
