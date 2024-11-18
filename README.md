# dlnacasts3

Query your local network for DLNA media renderers and have them play media

Note: dlnacasts3 is a fork of rslavin abandonned dlnacasts2 (itself based on grunjol's dlnacasts). It has been updated for security reasons, including some hotfixes from contributors (see commit list). API (and code) based on mafintosh/chromecasts for DLNA. 

## Updating from 0.x.x to 1.x.x
Breaking changes: 
- `const list = dlnacasts()` will no longer trigger a `list.update()`
- `player.on('status', status)` has changed, see below

## Usage
```
npm install dlnacasts3
```
then in your JS files: 
``` js
const dlnacasts = require('dlnacasts3')()

dlnacasts.on('update', function (player) {
  console.log('all players: ', dlnacasts.players)
  player.play('http://example.com/my-video.mp4', {title: 'my video', type: 'video/mp4'})
})
```

## API

#### `const list = dlnacasts()`

Creates a dlna list.

#### `list.update()`

Updates the player list by querying the local network for DLNA renderer instances.

#### `list.on('update', player)`

Emitted when a new player is found on the local network

#### `player.play(url, [opts], cb)`

Make the player play a url. Options include:

``` js
{
  title: 'My movie',
  type: 'video/mp4',
  dlnaFeatures: 'DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01100000000000000000000000000000', // this enables seeking in some dlna devices like LG WebOS
  seek: seconds, // start by seeking to this offset
  subtitles: ['http://example.com/sub.vtt'], // subtitle track 1,
  autoSubtitles: true // enable first track if you provide subs
}
```

#### `player.subtitles(track, [cb])`

Enable subtitle track. Use `player.subtitles(false)` to disable subtitles

#### `player.pause([cb])`

Make the player pause playback

#### `player.resume([cb])`

Resume playback

#### `player.stop([cb])`

Stop the playback

#### `player.seek(seconds, [cb])`

Seek the video

### `player.status([cb])`

Get a status of what's playing on the renderer. Similar to `player.on('status', cb)` event but manually triggered

### `player.getVolume([cb])`

Get the volume of the renderer

### `player.setVolume(<volume>, [cb])`

Set the volume on the renderer

#### `player.on('status', status)`

Emitted when a status object is received.

status Object()
```js
{
  currentTime: 122, // time in seconds (122 = 00:02:02)
  playerState: "PAUSED_PLAYBACK", // player State: see below
  volume: {
    level: 0.1  // 0.1 corresponds to 10 on a scale of 100
  }
}
```

`status.playerState` could be one of :
```js
[
  'PLAYING', // player is playing a video (player.pause() to pause)
  'STOPPED',  // player was quit by user
  'PAUSED_PLAYBACK', // player was paused (player.play() to continue)
  'NO_MEDIA_PRESENT', // usually after a 'STOPPED'
  'TRANSITIONNING' // DLNA renderer is loading something
]
```

## License

MIT
