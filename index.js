var MediaRenderer = require('upnp-mediarenderer-client')
var events = require('events')
var get = require('simple-get')
var parallel = require('run-parallel')
var parseString = require('xml2js').parseString

var SSDP
try {
  SSDP = require('node-ssdp').Client
} catch (err) {
  SSDP = null
}

var SERVICE_TYPE = 'urn:schemas-upnp-org:device:MediaRenderer:1';
var thunky = require('thunky')

var noop = function () {}

module.exports = function () {
  var that = new events.EventEmitter()
  var casts = {}
  var ssdp = SSDP ? new SSDP() : null

  that.players = []

  var emit = function (cst) {
    if (!cst || !cst.host || cst.emitted) return
    cst.emitted = true

    var player = new events.EventEmitter()

    var connect = thunky(function reconnect (cb) {
      var client = new MediaRenderer(player.xml)

      client.on('error', function (err) {
        player.emit('error', err)
      })

      client.on('status', function (status) {
        if (status.TransportState === 'PAUSED_PLAYBACK') player._status.playerState = 'PAUSED'
        else if(status.TransportState) player._status.playerState = status.TransportState
        player.emit('status', player._status)
      })

      client.on('loading', function (err) {
        player.emit('loading', err)
      })

      client.on('close', function () {
        connect = thunky(reconnect)
      })

      player.client = client
      cb(null, player.client)
    })

    var parseTime = function (time) {
      if (!time || time.indexOf(':') === -1) return 0
      var parts = time.split(':').map(Number)
      return parts[0] * 3600 + parts[1] * 60 + parts[2]
    }

    player.name = cst.name
    player.host = cst.host
    player.xml = cst.xml
    player._status = {}
    player.MAX_VOLUME = 100

    player.connect = connect
    player.close = function(cb) {
      if(player.client) {
        for(e of ["error", "status", "loading", "close"]) {
          player.client.removeAllListeners(e)
        }
        player.client = undefined
      }
      if(cb) {
        cb()
      }
    }

    player.play = function (url, opts, cb) {
      if (typeof opts === 'function') return player.play(url, null, opts)
      if (!opts) opts = {}
      if (!url) return player.resume(cb)
      if (!cb) cb = noop
      player.subtitles = opts.subtitles
      connect(function (err, p) {
        if (err) return cb(err)

        var media = {
          autoplay: opts.autoPlay !== false,
          contentType: opts.type || 'video/mp4',
          metadata: opts.metadata || {
            title: opts.title || '',
            type: 'video', // can be 'video', 'audio' or 'image'
            subtitlesUrl: player.subtitles && player.subtitles.length ? player.subtitles[0] : null
          }
        }
        if (opts.dlnaFeatures) {
          media.dlnaFeatures = opts.dlnaFeatures; // for LG WebOS 'DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01100000000000000000000000000000' allows seeking
        }

        var callback = cb
        if (opts.seek) {
          callback = function(err) {
            if(err) {
              return cb(err)
            }
            player.seek(opts.seek, cb)
          }
        }

        p.load(url, media, callback)
      })
    }

    player.resume = function (cb) {
      if (!cb) cb = noop
      player.client.play(cb)
    }

    player.pause = function (cb) {
      if (!cb) cb = noop
      player.client.pause(cb)
    }

    player.stop = function (cb) {
      if (!cb) cb = noop
      player.client.stop(cb)
    }

    player.status = function (cb) {
      if (!cb) cb = noop
      parallel({
        currentTime: function (acb) {
          var params = {
            InstanceID: player.client.instanceId
          }
          player.client.callAction('AVTransport', 'GetPositionInfo', params, function (err, res) {
            if (err) return acb()
            var position = parseTime(res.AbsTime) | parseTime(res.RelTime)
            acb(null, position)
          })
        },
        volume: function (acb) {
          player._volume(acb)
        }
      },
      function (err, results) {
        console.debug('dlnacasts player.status results: %o', results)
        player._status.currentTime = results.currentTime
        player._status.volume = {level: results.volume / (player.MAX_VOLUME)}
        return cb(err, player._status)
      })
    }

    player._volume = function (cb) {
      var params = {
        InstanceID: player.client.instanceId,
        Channel: 'Master'
      }
      player.client.callAction('RenderingControl', 'GetVolume', params, function (err, res) {
        if (err) return cb()
        var volume = res.CurrentVolume ? parseInt(res.CurrentVolume) : 0
        cb(null, volume)
      })
    }

    player.volume = function (vol, cb) {
      if (!cb) cb = noop
      var params = {
        InstanceID: player.client.instanceId,
        Channel: 'Master',
        DesiredVolume: (player.MAX_VOLUME * vol) | 0
      }
      player.client.callAction('RenderingControl', 'SetVolume', params, cb)
    }

    player.request = function (target, action, data, cb) {
      if (!cb) cb = noop
      player.client.callAction(target, action, data, cb)
    }

    player.seek = function (time, cb) {
      if (!cb) cb = noop
      player.client.seek(time, cb)
    }

    player._detectVolume = function (cb) {
      if (!cb) cb = noop
      player._volume(function (err, currentVolume) {
        if (err) cb(err)
        player.volume(player.MAX_VOLUME, function (err) {
          if (err) cb(err)
          player._volume(function (err, maxVolume) {
            if (err) cb(err)
            player.MAX_VOLUME = maxVolume
            player.volume(currentVolume, function (err) {
              cb(err, maxVolume)
            })
          })
        })
      })
    }

    that.players.push(player)
    that.emit('update', player)
  }

  if (ssdp) {
    ssdp.on('response', function (headers, statusCode, info) {
      if (!headers.LOCATION) return
      if (headers.ST !== SERVICE_TYPE) return

      get.concat(headers.LOCATION, function (err, res, body) {
        if (err) return
        parseString(body.toString(), {explicitArray: false, explicitRoot: false},
          function (err, service) {
            if (err) return
            if (!service.device) return

            console.debug('dlnacasts ssdp device: %j', service.device)

            var name = service.device.friendlyName

            if (!name) return

            var host = info.address
            var xml = headers.LOCATION

            if (!casts[name]) {
              casts[name] = {name: name, host: host, xml: xml}
              return emit(casts[name])
            }

            if (casts[name] && !casts[name].host) {
              casts[name].host = host
              casts[name].xml = xml
              emit(casts[name])
            }
          })
      })
    })
  }

  that.update = function () {
    console.debug('dlnacasts.update: querying ssdp')
    if (ssdp) {
		ssdp.search(SERVICE_TYPE);
		setTimeout(function() {},5000);
	}
  }

  that.on('removeListener', function () {
    if (ssdp && that.listenerCount('update') === 0) {
      ssdp.stop()
    }
  })

  that.destroy = function () {
    console.debug('dlnacasts.destroy: destroying ssdp...')
    if (ssdp) {
      ssdp.stop()
    }
  }

  that.close = function () {
    that.removeAllListeners('update')
  }

  that.update()

  return that
}
