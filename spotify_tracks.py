import sys, json, io

if hasattr(sys.stdout, 'buffer'):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

item_type = sys.argv[1] if len(sys.argv) > 1 else 'playlist'
item_id = sys.argv[2] if len(sys.argv) > 2 else sys.argv[1]

if item_type == 'album':
    from spotapi import PublicAlbum
    obj = PublicAlbum(item_id)
    pages = obj.get_album_info()
    pages = [pages]
else:
    from spotapi import PublicPlaylist
    obj = PublicPlaylist(item_id)
    pages = obj.paginate_playlist()

all_tracks = []

def extract_tracks(data):
    result = []
    def walk(obj):
        if isinstance(obj, dict):
            if obj.get('__typename') == 'Track':
                name = obj.get('name', '')
                artists = [a.get('profile',{}).get('name','') for a in (obj.get('albumOfTrack',{}).get('artists',{}).get('items',[]) or obj.get('artists',{}).get('items',[]))]
                if name:
                    result.append((name + ' - ' + ', '.join(artists)) if artists else name)
            for v in obj.values():
                walk(v)
        elif isinstance(obj, list):
            for i in obj:
                walk(i)
    walk(data)
    return result

for page in pages:
    tracks = extract_tracks(page)
    all_tracks.extend(tracks)

print(json.dumps(all_tracks, ensure_ascii=False))
