"""Lists every file in tools/edzco-sound/sounds/ in that tool's component.json.

The Store packs a tool from the files its component.json names one by one (a folder entry is
not expanded), so run this after adding or removing a sound:

    python docs/sync_sound_manifest.py
"""
import collections
import json
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
TOOL = os.path.join(ROOT, 'tools', 'edzco-sound')
COMP = os.path.join(TOOL, 'component.json')


def main():
    with open(COMP, encoding='utf-8') as f:
        c = json.load(f, object_pairs_hook=collections.OrderedDict)
    own = [e for e in c['files'] if not e['path'].startswith('sounds')]
    sounds = sorted(n for n in os.listdir(os.path.join(TOOL, 'sounds'))
                    if os.path.isfile(os.path.join(TOOL, 'sounds', n)))
    c['files'] = own + [collections.OrderedDict([('path', 'sounds/' + n), ('from', 'sounds/' + n), ('mode', '0644')])
                        for n in sounds]
    with open(COMP, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(c, f, indent=2, ensure_ascii=False)
        f.write('\n')
    print('%s: %d files, %d of them sounds' % (os.path.relpath(COMP, ROOT), len(c['files']), len(sounds)))


if __name__ == '__main__':
    main()
