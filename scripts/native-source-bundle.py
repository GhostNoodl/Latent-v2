"""Assemble or verify the allowlisted native-source companion. Python 3.11+."""
import argparse
import hashlib
import json
import pathlib
import zipfile

PROJECT = pathlib.Path(__file__).resolve().parent.parent
DOCS = PROJECT / 'docs' / 'public'

def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def verify(archive):
    with zipfile.ZipFile(archive) as bundle:
        manifest = json.loads(bundle.read('SOURCE-MANIFEST.json'))
        entries = bundle.namelist()
        expected = {i['path'] for i in manifest['files']} | {
            'SOURCE-MANIFEST.json', 'NATIVE-SOURCES.md', 'native-source-provenance.json',
            'native-source-bundle.py', 'THIRD-PARTY-NOTICES.txt',
        }
        if len(entries) != len(set(entries)) or set(entries) != expected:
            raise ValueError('Missing, duplicate, or unexpected archive entries')
        for item in manifest['files']:
            info = bundle.getinfo(item['path'])
            if info.file_size != item['bytes']:
                raise ValueError('Size mismatch: ' + item['path'])
            with bundle.open(info) as stream:
                actual = hashlib.file_digest(stream, 'sha256').hexdigest()
            if actual != item['sha256']:
                raise ValueError('Checksum mismatch: ' + item['path'])
    print(f'Verified {len(manifest["files"])} source archives and build inputs.')

def build(inputs, output):
    manifest = json.loads((DOCS / 'native-source-inputs.json').read_text(encoding='utf-8'))
    root = inputs.resolve(strict=True)
    verified = []
    for item in manifest['files']:
        relative = pathlib.PurePosixPath(item['path'])
        if relative.is_absolute() or '..' in relative.parts or '\\' in item['path']:
            raise ValueError('Invalid source path')
        file = root.joinpath(*relative.parts)
        if file.is_symlink() or not file.resolve(strict=True).is_relative_to(root):
            raise ValueError('Linked source outside input folder')
        if file.stat().st_size != item['bytes'] or digest(file) != item['sha256']:
            raise ValueError('Source checksum mismatch: ' + item['path'])
        verified.append((file, item['path']))
    # Inputs are already compressed; storing avoids recompressing hundreds of archives.
    with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_STORED, allowZip64=True) as bundle:
        for file, name in verified:
            bundle.write(file, name)
        bundle.writestr('SOURCE-MANIFEST.json', json.dumps(manifest, indent=2) + '\n')
        for name in ['NATIVE-SOURCES.md', 'native-source-provenance.json']:
            bundle.write(DOCS / name, name)
        bundle.write(PROJECT / 'scripts' / 'native-source-bundle.py', 'native-source-bundle.py')
        bundle.write(PROJECT / 'THIRD-PARTY-NOTICES.txt', 'THIRD-PARTY-NOTICES.txt')
    verify(output)
    print('SHA256 ' + digest(output) + '  ' + output.name)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify', type=pathlib.Path)
    parser.add_argument('--inputs', type=pathlib.Path)
    parser.add_argument('--output', type=pathlib.Path)
    args = parser.parse_args()
    if args.verify:
        verify(args.verify)
    elif args.inputs and args.output:
        build(args.inputs, args.output)
    else:
        parser.error('Use --verify ARCHIVE or --inputs DIRECTORY --output NEW_ARCHIVE')
