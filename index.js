const MediaRenderer = require('upnp-mediarenderer-client')
const events = require('events')
const get = require('simple-get')
const parallel = require('run-parallel')
const parseString = require('xml2js').parseString
const SSDP = require('node-ssdp').Client

const SERVICE_TYPE = 'urn:schemas-upnp-org:device:MediaRenderer:1';
const thunky = require('thunky')

const noop = () => {}

module.exports = () => {
  const that = new events.EventEmitter()
  const casts = {}
  const ssdp = SSDP ? new SSDP() : null

  that.players = []

  const emit = (cst) => {
    if (!cst || !cst.host || cst.emitted) return
    cst.emitted = true

    const player = new events.EventEmitter()

    const connect = thunky(function reconnect (cb) {
      const client = new MediaRenderer(player.xml)

      client.on('error', (err) => {
        player.emit('error', err)
      })

      client.on('status', (status) => {
        if (status.TransportState === 'PAUSED_PLAYBACK') player._status.playerState = 'PAUSED'
        else if(status.TransportState) player._status.playerState = status.TransportState
        player.emit('status', player._status)
      })

      client.on('loading', (err) => {
        player.emit('loading', err)
      })

      client.on('close', () => {
        connect = thunky(reconnect)
      })

      player.client = client
      cb(null, player.client)
    })

    const parseTime = (time) => {
      if (!time || time.indexOf(':') === -1) return 0
      const parts = time.split(':').map(Number)
      return parts[0] * 3600 + parts[1] * 60 + parts[2]
    }

    player.name = cst.name
    player.host = cst.host
    player.xml = cst.xml
    player._status = {}
    player.MAX_VOLUME = 100

    player.connect = connect
    player.close = (cb) => {
      if(player.client) {
        for(e of ["error", "status", "loading", "close"]) {
          player.client.removeAllListeners(e)
        }
        player.client = undefined
      }
      if(cb) cb()
    }

    player.play = (url, opts, cb) => {
      if (typeof opts === 'function') return player.play(url, null, opts)
      if (!opts) opts = {}
      if (!url) return player.resume(cb)
      if (!cb) cb = noop
      player.subtitles = opts.subtitles
      connect((err, p) => {
        if (err) return cb(err)

        const media = {
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

        let callback = cb
        if (opts.seek) {
          callback = (err) => {
            if(err) return cb(err)
            player.seek(opts.seek, cb)
          }
        }

        p.load(url, media, callback)
      })
    }

    player.resume = (cb) => {
      if (!cb) cb = noop
      player.client.play(cb)
    }

    player.pause = (cb) => {
      if (!cb) cb = noop
      player.client.pause(cb)
    }

    player.stop = (cb) => {
      if (!cb) cb = noop
      player.client.stop(cb)
    }

    player.status = (cb) => {
      if (!cb) cb = noop
      parallel({
        currentTime: (acb) => {
          player.client.callAction('AVTransport', 'GetPositionInfo', {
            InstanceID: player.client.instanceId
          }, (err, res) => {
            if (err) return acb()
            acb(null, parseTime(res.AbsTime) | parseTime(res.RelTime))
          })
        },
        volume: (acb) => {
          player._volume(acb)
        }
      },
      (err, results) => {
        console.debug('dlnacasts player.status results: %o', results)
        player._status.currentTime = results.currentTime
        player._status.volume = {level: results.volume / (player.MAX_VOLUME)}
        return cb(err, player._status)
      })
    }

    player._volume = (cb) => {
      player.client.callAction('RenderingControl', 'GetVolume', {
        InstanceID: player.client.instanceId,
        Channel: 'Master'
      }, (err, res) => {
        if (err) return cb()
        cb(null, res.CurrentVolume ? parseInt(res.CurrentVolume) : 0)
      })
    }

    player.volume = (vol, cb) => {
      if (!cb) cb = noop
      player.client.callAction('RenderingControl', 'SetVolume', {
        InstanceID: player.client.instanceId,
        Channel: 'Master',
        DesiredVolume: (player.MAX_VOLUME * vol) | 0
      }, cb)
    }

    player.request = (target, action, data, cb) => {
      if (!cb) cb = noop
      player.client.callAction(target, action, data, cb)
    }

    player.seek = (time, cb) => {
      if (!cb) cb = noop
      player.client.seek(time, cb)
    }

    player._detectVolume = (cb) => {
      if (!cb) cb = noop
      player._volume((err, currentVolume) => {
        if (err) cb(err)
        player.volume(player.MAX_VOLUME, (err) => {
          if (err) cb(err)
          player._volume((err, maxVolume) => {
            if (err) cb(err)
            player.MAX_VOLUME = maxVolume
            player.volume(currentVolume, (err) => {
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
    ssdp.on('response', (headers, statusCode, info) => {
      if (!headers.LOCATION) return
      if (headers.ST !== SERVICE_TYPE) return

      get.concat(headers.LOCATION, (err, res, body) => {
        if (err) return
        parseString(body.toString(), {explicitArray: false, explicitRoot: false},
          (err, service) => {
            if (err) return
            if (!service.device) return

            console.debug('dlnacasts ssdp device: %j', service.device)

            const name = service.device.friendlyName

            if (!name) return

            const host = info.address
            const xml = headers.LOCATION

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

  that.update = () => {
    console.debug('dlnacasts.update: querying ssdp')
    if (ssdp) {
      ssdp.search(SERVICE_TYPE)
      setTimeout(() => {}, 5000)
    }
  }

  that.on('removeListener', () => {
    if (ssdp && that.listenerCount('update') === 0) {
      ssdp.stop()
    }
  })

  that.destroy = () => {
    console.debug('dlnacasts.destroy: destroying ssdp...')
    if (ssdp) {
      ssdp.stop()
    }
  }

  that.close = () => {
    that.removeAllListeners('update')
  }

  that.update()

  return that
}
