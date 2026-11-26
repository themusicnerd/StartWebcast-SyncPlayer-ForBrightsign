Sub Main()
    m.runtime = GetDefaultDrive()
    m.slot = "base"
    m.updateDeadline = 0
    slot = ReadAsciiFile(m.runtime + "suite-launch.txt")
    If slot <> "" And slot <> "base" Then
        path = m.runtime + "updates/slots/" + slot + "/"
        If ReadAsciiFile(path + "VERSION").Trim() = slot Then
            m.slot = slot
            m.runtime = path
            If ReadAsciiFile(path + "healthy.txt") <> "yes" Then m.updateDeadline = UpTime(0) + 120
        End If
    End If
    m.version = ReadAsciiFile(m.runtime + "VERSION").Trim()
    m.systemLog = CreateObject("roSystemLog")
    m.playerId = ""
    port = CreateObject("roMessagePort")
    m.holding = invalid
    m.clockWeb = invalid
    m.clock = invalid
    m.panel = invalid
    RunPlayback(port)
    ' Leave the display idle for diagnosis after a boot or playback fault.
    While true
        HandleClockWeb(Wait(500, port))
        If m.panel <> invalid Then PanelRestart(m.panel)
        CheckUpdateBoot()
    End While
End Sub

Sub RunPlayback(port As Object)
    device = CreateObject("roDeviceInfo")
    If device = invalid Then
        LogEvent("DEVICE_INFO_UNAVAILABLE", {})
        Return
    End If
    model = device.GetModel()
    LogEvent("BOOT", {model: model, firmware: device.GetVersion(), device_id: device.GetDeviceUniqueId()})
    If UCase(model) <> "XD236" Then
        LogEvent("UNSUPPORTED_MODEL", {model: model})
        Return
    End If

    root = GetDefaultDrive()
    config = ParseJson(ReadAsciiFile(root + "syncplayer.json"))
    If not ValidConfig(config) Then
        LogEvent("INVALID_CONFIG", {})
        Return
    End If

    cardId = config.card_player_id
    network = CreateObject("roNetworkConfiguration", "eth0")
    If network = invalid Then
        LogEvent("NETWORK_INTERFACE_UNAVAILABLE", {interface_name: "eth0"})
        Return
    End If
    scheduled = config.display_schedule <> invalid
    clock = invalid
    If scheduled Then
        clock = CreateObject("roSystemTime")
        If clock = invalid Then
            LogEvent("SCHEDULE_CLOCK_UNAVAILABLE", {})
        Else If UCase(clock.GetTimeZone()) <> "AEST" Then
            If not clock.SetTimeZone("AEST") Then LogEvent("TIME_ZONE_REJECTED", {})
        End If
    End If

    mode = CreateObject("roVideoMode")
    If mode = invalid Then
        LogEvent("VIDEO_MODE_UNAVAILABLE", {})
        Return
    End If
    If cardId <> invalid Then m.holding = ShowHolding(mode, root + "media/HOLDING.jpeg")

    address = WaitForAddress(network, config.players, cardId, port)
    If address = "" Then Return

    m.playerId = config.players[address]
    If cardId <> invalid Then
        If m.playerId <> invalid And cardId <> m.playerId Then
            LogEvent("WRONG_PLAYER_CARD", {card_id: cardId, ip: address})
            Return
        End If
        m.playerId = cardId
    End If
    targetMode = "1920x1080x60p"
    mediaName = "FrameCounter_" + m.playerId + ".mp4"
    contentId = "counter-r1"
    If cardId <> invalid Then
        targetMode = config.output_mode
        mediaName = "Presentation_" + m.playerId + ".mp4"
        contentId = "presentation-r1"
    End If
    mediaPath = root + "media/" + mediaName
    panel = NewPanel(config, device, mode, network, clock, root, address, targetMode, mediaPath, contentId, port)
    panel.expectedAddress = ""
    For Each ip In config.players
        If config.players[ip] = m.playerId Then panel.expectedAddress = ip
    End For
    m.panel = panel
    m.clock = clock
    If scheduled Then ConfigureDefaultNtp(panel)
    If scheduled And cardId = m.playerId And clock <> invalid Then
        If ReadAsciiFile(root + "clock/credentials.json") <> "" Then
            m.clockWeb = CreateObject("roNodeJs", m.runtime + "clock/server.js", {message_port: port, arguments: [address, m.slot]})
            If m.clockWeb = invalid Then LogEvent("WEB_INTERFACE_UNAVAILABLE", {})
        End If
    End If
    If panel.role <> "standalone" And panel.address <> panel.expectedAddress Then
        panel.error = "The Ethernet IP Does Not Match This Player’s Group Address. Open Network Settings to Restore It."
        Return
    End If
    leader = (panel.role = "leader")
    targetMode = panel.settings.output
    LogEvent("ROLE_ASSIGNED", {ip: address, leader: leader, group: config.group_id, loop_mode: config.loop_mode})

    video = CreateObject("roVideoPlayer")
    If video = invalid Then
        LogEvent("NATIVE_VIDEO_UNAVAILABLE", {})
        Return
    End If
    panel.video = video
    If panel.settings.rotation <> 0 Then
        If not video.SetTransform(VideoRotation(panel.settings.rotation)) Then
            LogEvent("OUTPUT_ROTATION_REJECTED", {rotation: panel.settings.rotation})
            panel.settings.rotation = 0
            SavePanel(panel, panel.settings)
        End If
    End If
    playable = video.GetFilePlayability(mediaPath)
    If playable = invalid Then
        LogEvent("LOCAL_CLIP_PROBE_FAILED", {path: mediaPath})
    Else If playable.file <> "playable" Or playable.video <> "playable" Then
        LogEvent("LOCAL_CLIP_UNPLAYABLE", {path: mediaPath, probe: playable})
    End If

    If panel.role <> "standalone" Then
        If not EnsurePtp(config) Then Return
    End If
    previousMode = mode.GetMode()
    If previousMode <> targetMode Then
        LogEvent("SET_OUTPUT_MODE", {previous: previousMode, requested: targetMode})
        ' A real mode change normally restarts the application on Series 6.
        If not mode.SetMode(targetMode) Then
            LogEvent("OUTPUT_MODE_REJECTED", {requested: targetMode})
            If targetMode = panel.defaultMode Then Return
            panel.settings.output = panel.defaultMode
            If not SavePanel(panel, panel.settings) Then Return
            targetMode = panel.defaultMode
            If not mode.SetMode(targetMode) Then Return
        End If
    End If

    If mode.GetMode() <> targetMode Then
        LogEvent("OUTPUT_MODE_MISMATCH", {actual: mode.GetMode(), requested: targetMode})
        Return
    End If

    If cardId <> invalid Then
        ' The first image was drawn in the boot-time graphics plane.
        If previousMode <> targetMode Or panel.settings.rotation <> 0 Then
            If m.holding <> invalid Then m.holding.Hide()
            m.holding = invalid
            m.holding = ShowHolding(mode, root + "media/HOLDING.jpeg", panel.settings.rotation)
        End If
        If not ConfigureCardAudio(video) Then Return
        ApplyVolume(panel, panel.settings)
        video.SetRectangle(PanelBounds(panel, panel.settings.rect))
        panel.graphicsFront = mode.SetGraphicsZOrder("front")
    End If

    If panel.role <> "standalone" Then
        manager = CreateObject("roSyncManager", {Domain: config.group_id})
        If manager = invalid Then
            LogEvent("SYNC_MANAGER_UNAVAILABLE", {})
            Return
        End If
        manager.SetPort(port)
        If not SetNativeLeader(manager, device, leader) Then
            LogEvent("SYNC_ROLE_REJECTED", {leader: leader})
            Return
        End If
        If config.enable_genlock Then
            If not mode.SetSyncDomain(config.group_id) Then
                LogEvent("GENLOCK_REQUEST_REJECTED", {})
                Return
            End If
        End If
        panel.manager = manager
    End If

    loopSetting = "NoLoop"
    If config.loop_mode = "seamless" Then loopSetting = "SeamlessLoopOrNotAtAll"
    If not video.SetLoopMode(loopSetting) Then
        LogEvent("LOOP_SETTING_REJECTED", {mode: loopSetting})
        Return
    End If
    video.SetPort(port)

    If scheduled Then
        panel.cec = CreateObject("roCecInterface")
        If panel.cec = invalid Then
            LogEvent("CEC_UNAVAILABLE", {})
        Else
            panel.cec.SetPort(port)
        End If
        ShowStartupCard(panel)
        If m.holding <> invalid Then m.holding.Hide()
    End If
    panel.readyAt = UpTime(0) + 10
    panel.state = "idle"
    panel.ready = true
    LogEvent("NATIVE_READY", {output_mode: mode.GetMode(), ptp_domain: config.ptp_domain, genlock_requested: config.enable_genlock, sync_quality: "unknown"})
    While true
        PanelTick(panel)
        event = Wait(500, port)
        eventType = Type(event)
        If eventType = "roNodeJsEvent" Then
            HandleClockWeb(event)
        Else If eventType = "roSyncManagerEvent" And not leader Then
            PanelFollow(panel, event)
        Else If eventType = "roVideoEvent" Then
            PanelVideoEvent(panel, event.GetInt())
        Else If eventType = "roCecRxFrameEvent" Then
            PanelCecInput(panel, event)
        End If
    End While
End Sub

Sub HandleClockWeb(event As Dynamic)
    If m.clockWeb = invalid Or Type(event) <> "roNodeJsEvent" Then Return
    payload = event.GetData()
    If payload.reason <> "message" Or Type(payload.message) <> "roAssociativeArray" Then Return
    request = payload.message
    If request.protocol <> "start-syncplayer-clock-v1" Or not TextValue(request.id) Then Return
    If Len(request.id) <> 32 Then Return
    ' Keep flags as strings across the native Node message bridge.
    response = {protocol: request.protocol, id: request.id, ok: "yes", valid: "no"}
    If request.action <> "set" And request.action <> "get" Then
        HandlePanelRequest(m.panel, request, response)
        m.clockWeb.PostJsMessage(response)
        Return
    End If
    If request.action = "set" Then
        response.ok = "no"
        If TextValue(request.utc) Then
            utc = CreateObject("roDateTime")
            If utc.FromIsoString(request.utc) Then
                If utc.GetYear() >= 2020 And utc.GetYear() < 2038 Then
                    If m.clock.SetUtcDateTime(utc) Then response.ok = "yes"
                End If
            End If
        End If
        If response.ok = "yes" Then LogEvent("OPERATOR_CLOCK_SET", {})
    End If
    If m.clock.IsValid() Then response.valid = "yes"
    response.utc = m.clock.GetUtcDateTime().ToIsoString()
    m.clockWeb.PostJsMessage(response)
End Sub

Function NewPanel(config As Object, device As Object, mode As Object, network As Object, clock As Dynamic, root As String, address As String, target As String, path As String, contentId As String, port As Object) As Object
    settings = {role: "follower", leader: config.leader_id, domain: config.ptp_domain, group: config.group_id, output: target, rotation: 0, volume: 100, muted: false, audioenabled: true, cecremote: false, audiorevision: "", presentationtitle: "Presentation", rect: {x: 0, y: 0, width: 100, height: 100}, overlay: "", loop: true, intent: "auto", selection: {kind: "built-in"}}
    title = ReadAsciiFile(root + "presentation-title.txt").Trim()
    If Len(title) > 0 And Len(title) <= 100 Then settings.presentationtitle = title
    If m.playerId = config.leader_id Then settings.role = "leader"
    scheduled = config.display_schedule <> invalid
    If scheduled Then
        settings.on = config.display_schedule.on
        settings.off = config.display_schedule.off
        settings.scheduleenabled = true
        If BooleanValue(config.display_schedule.enabled) Then settings.scheduleenabled = config.display_schedule.enabled
    End If
    registry = CreateObject("roRegistrySection", "StartSyncPlayerSuite")
    If registry <> invalid And scheduled Then
        saved = ParseJson(registry.Read("settings"))
        If Type(saved) = "roAssociativeArray" Then
            For Each key In settings
                If key <> "overlay" And saved[key] <> invalid Then settings[key] = saved[key]
            End For
        End If
    End If
    If not ValidRotation(settings.rotation) Then settings.rotation = 0
    config.group_id = settings.group
    config.ptp_domain = settings.domain
    config.leader_id = settings.leader
    settings.ntp = network.GetTimeServer()
    settings.interval = network.GetTimeServerIntervalSeconds()
    panel = {settings: settings, registry: registry, role: settings.role, address: address, root: root, mode: mode, network: network, clock: clock, port: port, model: device.GetModel(), firmware: device.GetVersion(), serial: device.GetDeviceUniqueId(), defaultMode: target, baseline: path, baselinePrefix: contentId, nativeLoop: config.loop_mode, scheduled: scheduled, manager: invalid, video: invalid, cec: invalid, ready: false, screens: false, before: invalid, autostart: false, rebootAt: 0, change: "", sequence: 0, syncId: "", syncTime: "", state: "booting", error: "", asset: "", revision: "", name: settings.presentationtitle, source: "built-in", url: "", base: invalid, overlay: invalid, htmlPort: invalid, overlayPort: invalid, overlayState: "off", loadAt: 0}
    panel.localOverride = false
    panel.groupCue = invalid
    RestoreSelection(panel)
    panel.waiting = panel.role = "leader" And panel.source = "group" And panel.settings.intent = "auto"
    panel.colour = {brightness: 0, hue: 0, saturation: 0}
    panel.memberUntil = 0
    panel.telemetryAt = 0
    panel.cecRequest = ""
    panel.cecAt = -1
    panel.device = device
    panel.networkNext = invalid
    panel.networkResult = ""
    panel.startup = invalid
    panel.identUntil = 0
    panel.retryAt = 0
    panel.retryDelay = 3
    panel.mediaCycle = ""
    Return panel
End Function

Function SavePanel(panel As Object, settings As Object) As Boolean
    If panel.registry = invalid Then Return false
    saved = {}
    For Each key In settings
        If key <> "overlay" Then saved[key] = settings[key]
    End For
    Return panel.registry.Write("settings", FormatJson(saved)) And panel.registry.Flush()
End Function

Function PanelStatus(panel As Object) As Object
    data = {playerid: m.playerId, role: panel.role, leader: panel.settings.leader, group: panel.settings.group, domain: panel.settings.domain, output: panel.mode.GetMode(), requestedoutput: panel.settings.output, volume: panel.settings.volume, muted: panel.settings.muted, state: panel.state, error: panel.error, source: panel.source, asset: panel.asset, revision: panel.revision, name: panel.name, loop: panel.settings.loop, display: panel.screens, waiting: panel.waiting, on: panel.settings.on, off: panel.settings.off, rect: panel.settings.rect, overlay: panel.settings.overlay <> "", overlaystate: panel.overlayState, ntp: panel.settings.ntp, interval: panel.settings.interval, firmware: panel.firmware, model: panel.model, serial: panel.serial, uptime: UpTime(0), pending: panel.change, version: m.version}
    data.colour = panel.colour
    data.scheduleenabled = panel.settings.scheduleenabled
    data.rotation = panel.settings.rotation
    data.audioenabled = panel.settings.audioenabled
    data.audiorevision = panel.settings.audiorevision
    data.presentationtitle = panel.settings.presentationtitle
    data.localoverride = panel.localOverride
    If BooleanValue(panel.before) Then data.scheduledwake = panel.before
    data.cecavailable = panel.cec <> invalid
    data.cecremote = panel.settings.cecremote
    data.ident = panel.startup <> invalid
    data.network = PanelNetwork(panel.network.GetCurrentConfig())
    data.networkresult = panel.networkResult
    If panel.scheduled Then
        data.temperature = panel.device.GetTemperature()
    End If
    data.cecrequest = panel.cecRequest
    data.tvpower = "unknown"
    hdmi = panel.mode.GetHdmiOutputStatus()
    data.screen = {connected: false}
    If Type(hdmi) = "roAssociativeArray" Then
        data.screen.connected = hdmi.output_present = true
        If hdmi.output_present = true And BooleanValue(hdmi.output_powered) Then
            data.tvpower = "off"
            If hdmi.output_powered Then data.tvpower = "on"
        End If
    End If
    If data.screen.connected Then
        edid = panel.mode.GetEdidIdentity(true)
        If Type(edid) = "roAssociativeArray" Then
            data.screen.manufacturer = edid.manufacturer
            data.screen.name = edid.monitor_name
            data.screen.product = edid.product
            data.screen.serial = edid.serial_number_string
            If not TextValue(data.screen.serial) Or data.screen.serial = "" Then data.screen.serial = edid.serial_number
        End If
    End If
    playback = PanelPlayback(panel)
    For Each key In playback
        data[key] = playback[key]
    End For
    If Type(panel.settings.selection) = "roAssociativeArray" Then
        data.savedasset = panel.settings.selection.asset
        data.startupsource = panel.settings.selection.kind
    End If
    If panel.clock <> invalid Then
        data.clockvalid = panel.clock.IsValid()
        If panel.scheduled Then
            info = panel.clock.GetLastNetworkTimeResult()
            If info <> invalid Then data.ntpresult = info
        End If
    End If
    Return data
End Function

Function PanelNetwork(data As Dynamic) As Object
    If Type(data) <> "roAssociativeArray" Then Return {}
    mode = "static"
    If data.dhcp = true Then mode = "dhcp"
    Return {mode: mode, address: data.ip4_address, netmask: data.ip4_netmask, broadcast: data.ip4_broadcast, gateway: data.ip4_gateway, dns: data.dns_servers, mac: data.ethernet_mac, hostname: data.hostname, mdns: data.mdns_hostname, link: data.link}
End Function

Function ApplyPanelNetwork(panel As Object, profile As Object) As Boolean
    network = panel.network
    If profile.mode = "dhcp" Then
        If not network.SetDHCP() Then Return false
        If not network.SetDNSServers([]) Then Return false
    Else
        If not network.ResetInterfaceSettings() Then Return false
        If not network.SetIP4Address(profile.address) Or not network.SetIP4Netmask(profile.netmask) Then Return false
        If not network.SetIP4Broadcast(profile.broadcast) Then Return false
        If TextValue(profile.gateway) And profile.gateway <> "" Then
            If not network.SetIP4Gateway(profile.gateway) Then Return false
        End If
        dns = profile.dns
        If Type(dns) <> "roArray" Then dns = []
        If not network.SetDNSServers(dns) Then Return false
    End If
    If not network.SetTimeServer(panel.settings.ntp) Then Return false
    If not network.SetTimeServerIntervalSeconds(panel.settings.interval) Then Return false
    Return network.Apply()
End Function

Sub CommitPanelNetwork(panel As Object)
    previous = PanelNetwork(panel.network.GetCurrentConfig())
    profile = panel.networkNext
    panel.networkNext = invalid
    If not TextValue(previous.address) Or previous.address = "" Then Return
    accepted = ApplyPanelNetwork(panel, profile)
    If accepted Then
        For attempt = 1 To 30
            current = PanelNetwork(panel.network.GetCurrentConfig())
            If current.link = true And current.mode = profile.mode And TextValue(current.address) And current.address <> "" Then
                correct = profile.mode = "dhcp" Or (current.address = profile.address And current.netmask = profile.netmask)
                If correct And (panel.role = "standalone" Or current.address = panel.expectedAddress) Then
                    LogEvent("ETHERNET_SETTINGS_APPLIED", {address: current.address, mode: profile.mode})
                    RebootSystem()
                    Return
                End If
            End If
            Sleep(1000)
        End For
    End If
    panel.networkResult = "The Ethernet Settings Could Not Be Verified. Previous Settings Restored."
    If not ApplyPanelNetwork(panel, previous) Then panel.networkResult = "Ethernet Settings Failed. Restore the Network From the Diagnostic Web Server or the SD Card."
    LogEvent("ETHERNET_SETTINGS_REJECTED", {restored: panel.networkResult})
End Sub

Function PanelGroupMedia(panel As Object) As Boolean
    Return panel.role <> "standalone" And (panel.source = "built-in" Or panel.source = "group")
End Function

Function PanelFileMedia(panel As Object) As Boolean
    Return not PanelLiveSource(panel)
End Function

Function PanelPlayback(panel As Object) As Object
    current = {state: panel.state, source: panel.source, name: panel.name, revision: panel.revision, error: panel.error, pending: panel.change, controlversion: 1, jumpversion: 1, cycle: panel.mediaCycle, synced: PanelGroupMedia(panel), pausable: false, seekable: false}
    If panel.video = invalid Or panel.source = "web" Then Return current
    If panel.state <> "playing" And panel.state <> "paused" And panel.state <> "starting" Then Return current
    current.positionms = panel.video.GetPlaybackPosition()
    current.durationms = panel.video.GetDuration()
    current.pausable = panel.role <> "follower" And PanelFileMedia(panel) And (panel.state = "playing" Or panel.state = "paused")
    current.seekable = current.pausable And not current.synced And current.durationms > 0
    Return current
End Function

Function PanelTransport(panel As Object, action As String, stamp As String) As String
    If not PanelFileMedia(panel) Then Return "Play an MP4 to use this transport control."
    wanted = "paused"
    previous = "playing"
    If action = "resume" Then
        wanted = "playing"
        previous = "paused"
    End If
    If panel.state = wanted Then Return ""
    If panel.state <> previous Then Return "The selected clip is not ready for that command."
    params = {}
    If stamp <> "" Then params.SyncIsoTimeStamp = stamp
    If action = "pause" Then
        accepted = panel.video.Pause(params)
    Else
        accepted = panel.video.Resume(params)
    End If
    If not accepted Then Return "The native player rejected the transport command."
    panel.state = wanted
    Return ""
End Function

Function ValidRotation(angle As Dynamic) As Boolean
    If not WholeNumber(angle) Then Return false
    Return angle = 0 Or angle = 90 Or angle = 180 Or angle = 270
End Function

Function GraphicsRotation(angle As Integer) As String
    If angle = 0 Then Return "identity"
    Return "rot" + Mid(StrI(angle), 2)
End Function

Function VideoRotation(angle As Integer) As String
    Return GraphicsRotation((360 - angle) Mod 360)
End Function

Function RotatedBounds(bounds As Object, angle As Integer) As Object
    x = bounds.x
    y = bounds.y
    width = bounds.width
    height = bounds.height
    If angle = 90 Then Return {x: 100 - y - height, y: x, width: height, height: width}
    If angle = 180 Then Return {x: 100 - x - width, y: 100 - y - height, width: width, height: height}
    If angle = 270 Then Return {x: y, y: 100 - x - width, width: height, height: width}
    Return bounds
End Function

Function PanelBounds(panel As Object, bounds As Object) As Object
    bounds = RotatedBounds(bounds, panel.settings.rotation)
    width = panel.mode.GetResX()
    height = panel.mode.GetResY()
    Return CreateObject("roRectangle", Int(width * bounds.x / 100), Int(height * bounds.y / 100), Int(width * bounds.width / 100), Int(height * bounds.height / 100))
End Function

Function ApplyVolume(panel As Object, settings As Object) As Boolean
    If panel.video = invalid Then Return true
    volume = settings.volume
    If settings.muted Or settings.audioenabled = false Then volume = 0
    Return panel.video.SetVolume(volume)
End Function

Sub ConfigureDefaultNtp(panel As Object)
    current = panel.settings.ntp
    If current <> "default://" And current <> "ntp://time.brightsignnetwork.com" Then Return
    defaultServer = "ntp://0.au.pool.ntp.org"
    If panel.network.SetTimeServer(defaultServer) Then
        If panel.network.Apply() Then
            panel.settings.ntp = panel.network.GetTimeServer()
            Return
        End If
    End If
    LogEvent("DEFAULT_NTP_REJECTED", {})
End Sub

Function SafeHex(value As Dynamic, length As Integer) As Boolean
    If not TextValue(value) Then Return false
    If Len(value) <> length Then Return false
    For i = 1 To length
        If Instr(1, "0123456789abcdef", Mid(value, i, 1)) = 0 Then Return false
    End For
    Return true
End Function

Function PanelAsset(panel As Object, digest As Dynamic) As String
    If not SafeHex(digest, 64) Then Return ""
    Return panel.root + "library/assets/" + digest + ".mp4"
End Function

Function VerifiedAsset(panel As Object, digest As Dynamic) As Boolean
    path = PanelAsset(panel, digest)
    If path = "" Or panel.video = invalid Then Return false
    result = panel.video.GetFilePlayability(path)
    If result = invalid Then Return false
    Return result.file = "playable" And result.video = "playable"
End Function

Sub RestoreSelection(panel As Object)
    selected = panel.settings.selection
    If Type(selected) <> "roAssociativeArray" Then Return
    If (selected.kind = "web" And PanelWebUrl(selected.url)) Or (selected.kind = "srt" And PanelSrtUrl(selected.url)) Or (selected.kind = "rtsp" And PanelRtspUrl(selected.url)) Then
        SetLiveSource(panel, selected.kind, selected.url, selected.name)
        panel.localOverride = panel.role = "follower"
        Return
    End If
    If selected.kind <> "group" And selected.kind <> "local" Then Return
    If selected.kind = "group" And not SafeHex(selected.revision, 24) Then Return
    If selected.kind = "local" And panel.role <> "standalone" Then Return
    If not SafeHex(selected.asset, 64) Or not TextValue(selected.name) Then Return
    panel.source = selected.kind
    panel.asset = selected.asset
    panel.name = selected.name
    If selected.kind = "group" Then panel.revision = selected.revision
End Sub

Sub PanelSignal(panel As Object, prefix As String)
    If panel.role <> "leader" Or panel.manager = invalid Then Return
    panel.sequence = panel.sequence + 1
    panel.manager.Synchronize(prefix + Mid(StrI(panel.sequence), 2), 0)
End Sub

Sub StopPanel(panel As Object, blackout As Boolean)
    panel.retryAt = 0
    panel.video.StopClear()
    If panel.base <> invalid Then panel.base.Hide()
    panel.base = invalid
    panel.htmlPort = invalid
    If blackout Then
        If m.holding <> invalid Then m.holding.Hide()
        If panel.overlay <> invalid Then panel.overlay.Hide()
        panel.overlay = invalid
        panel.overlayPort = invalid
        panel.overlayState = "off"
        panel.state = "blackout"
    Else
        If m.holding <> invalid Then m.holding.Show()
        panel.state = "idle"
        RefreshOverlay(panel)
    End If
End Sub

Function PanelWebUrl(value As Dynamic) As Boolean
    If not TextValue(value) Then Return false
    Return Len(value) <= 1024 And (Left(value, 7) = "http://" Or Left(value, 8) = "https://")
End Function

Function PanelSrtUrl(value As Dynamic) As Boolean
    If not TextValue(value) Then Return false
    Return Len(value) <= 1024 And Left(value, 6) = "srt://"
End Function

Function PanelRtspUrl(value As Dynamic) As Boolean
    If not TextValue(value) Then Return false
    Return Len(value) <= 1024 And Left(value, 7) = "rtsp://"
End Function

Function PanelLiveSource(panel As Object) As Boolean
    Return panel.source = "web" Or panel.source = "srt" Or panel.source = "rtsp"
End Function

Sub SetLiveSource(panel As Object, kind As String, url As String, name As Dynamic)
    panel.source = kind
    panel.name = "Webpage"
    If kind = "srt" Then panel.name = "SRT Feed"
    If kind = "rtsp" Then panel.name = "RTSP Feed"
    If TextValue(name) And Len(name) > 0 And Len(name) <= 80 Then panel.name = name
    panel.asset = ""
    panel.revision = ""
    panel.url = url
End Sub

Sub RememberLiveSource(panel As Object)
    previous = panel.settings.selection
    If Type(previous) = "roAssociativeArray" Then
        If previous.kind = panel.source And previous.url = panel.url And previous.name = panel.name Then Return
    End If
    panel.settings.selection = {kind: panel.source, url: panel.url, name: panel.name}
    If not SavePanel(panel, panel.settings) Then
        panel.settings.selection = previous
        panel.error = "The Live Source Started but Its Startup Selection Could Not Be Saved."
    End If
End Sub

Function HtmlLayer(url As String, bounds As Object, port As Object, rotation As Integer) As Dynamic
    options = {url: url, port: port, nodejs_enabled: false, brightsign_js_objects_enabled: false, security_params: {websecurity: true, insecure_https_enabled: false}, pcm_audio_outputs: []}
    If rotation <> 0 Then options.transform = GraphicsRotation(rotation)
    Return CreateObject("roHtmlWidget", bounds, options)
End Function

Function ShowStartupCard(panel As Object) As Boolean
    HideStartupCard(panel)
    encoding = CreateObject("roUrlTransfer")
    If encoding = invalid Then Return false
    data = {player: m.playerId, ip: panel.address, mac: "", serial: panel.serial, model: panel.model, firmware: panel.firmware, version: m.version, repository: "themusicnerd/StartWebcast-SyncPlayer-ForBrightsign", output: panel.mode.GetMode(), rotation: panel.settings.rotation, audio: panel.settings.audioenabled, volume: panel.settings.volume, mute: panel.settings.muted, domain: panel.settings.domain, role: panel.role, group: panel.settings.group, ntp: panel.settings.ntp}
    network = panel.network.GetCurrentConfig()
    If Type(network) = "roAssociativeArray" And TextValue(network.ethernet_mac) Then data.mac = network.ethernet_mac
    updater = ParseJson(ReadAsciiFile(panel.root + "updates/github.json"))
    If Type(updater) = "roAssociativeArray" And TextValue(updater.repository) Then data.repository = updater.repository
    lighting = ParseJson(ReadAsciiFile(panel.root + "library/lighting.json"))
    If Type(lighting) = "roAssociativeArray" Then
        data.lighting = {protocol: lighting.protocol, universe: lighting.universe, channel: lighting.channel, source: lighting.source}
    End If
    If panel.clock <> invalid Then
        If panel.clock.IsValid() Then data.utc = panel.clock.GetUtcDateTime().ToIsoString()
        result = panel.clock.GetLastNetworkTimeResult()
        If Type(result) = "roAssociativeArray" Then
            data.ntpsuccess = result.success_timestamp
            data.ntperror = result.failure_reason
        End If
    End If
    url = "file:/" + m.runtime + "clock/layer.html?startup=" + encoding.Escape(FormatJson(data))
    screen = CreateObject("roRectangle", 0, 0, panel.mode.GetResX(), panel.mode.GetResY())
    panel.startup = HtmlLayer(url, screen, CreateObject("roMessagePort"), panel.settings.rotation)
    If panel.startup = invalid Then Return false
    If not panel.startup.Show() Then
        panel.startup = invalid
        Return false
    End If
    panel.startup.Raise()
    Return true
End Function

Sub HideStartupCard(panel As Object)
    If panel.startup = invalid Then Return
    panel.startup.Hide()
    panel.startup = invalid
    panel.identUntil = 0
End Sub

Sub PanelCecInput(panel As Object, event As Object)
    If panel.settings.cecremote <> true Or m.clockWeb = invalid Then Return
    frame = event.GetByteArray()
    If frame.Count() < 3 Then Return
    destination = panel.cec.GetLogicalAddress()
    ' Accept transport keys addressed to this player by the TV (logical address zero).
    If destination = 15 Or frame[0] <> destination Or frame[1] <> &h44 Then Return
    key = frame[2]
    action = ""
    If key = &h44 Or key = &h60 Then action = "play"
    If key = &h46 Or key = &h61 Then action = "pause"
    If key = &h45 Or key = &h64 Then action = "stop"
    If action = "" Or UpTime(0) = panel.cecAt Then Return
    panel.cecAt = UpTime(0)
    m.clockWeb.PostJsMessage({protocol: "start-syncplayer-cec-v1", action: action})
End Sub

Function LayerDocument(panel As Object, base As String) As String
    encode = CreateObject("roUrlTransfer")
    If encode = invalid Then Return ""
    url = "file:/" + m.runtime + "clock/layer.html?overlay=" + encode.Escape(panel.settings.overlay)
    If base <> "" Then url = url + "&base=" + encode.Escape(base) + "&rect=" + encode.Escape(FormatJson(panel.settings.rect))
    Return url
End Function

Function StartWebLayer(panel As Object) As Boolean
    If panel.overlay <> invalid Then panel.overlay.Hide()
    panel.overlay = invalid
    panel.overlayPort = invalid
    If panel.base <> invalid Then panel.base.Hide()
    panel.base = invalid
    panel.htmlPort = CreateObject("roMessagePort")
    panel.overlayState = "off"
    url = panel.url
    bounds = PanelBounds(panel, panel.settings.rect)
    If PanelWebUrl(panel.settings.overlay) Then
        url = LayerDocument(panel, panel.url)
        If url = "" Then Return false
        bounds = PanelBounds(panel, {x: 0, y: 0, width: 100, height: 100})
        panel.overlayState = "loading"
    End If
    panel.base = HtmlLayer(url, bounds, panel.htmlPort, panel.settings.rotation)
    If panel.base = invalid Then Return false
    Return panel.base.Show()
End Function

Sub RefreshOverlay(panel As Object)
    If panel.source = "web" And (panel.state = "starting" Or panel.state = "playing") Then
        panel.state = "starting"
        panel.loadAt = UpTime(0)
        If not StartWebLayer(panel) Then
            panel.state = "error"
            panel.error = "The web layers could not be initialized."
        End If
        Return
    End If
    If panel.overlay <> invalid And panel.overlayUrl = panel.settings.overlay And panel.state <> "blackout" Then Return
    If panel.overlay <> invalid Then panel.overlay.Hide()
    panel.overlay = invalid
    panel.overlayPort = invalid
    panel.overlayState = "off"
    If panel.state = "blackout" Or not PanelWebUrl(panel.settings.overlay) Then Return
    If not panel.graphicsFront Then
        panel.overlayState = "graphics-order-error"
        Return
    End If
    If m.holding <> invalid Then m.holding.Hide()
    panel.overlayUrl = panel.settings.overlay
    panel.overlayPort = CreateObject("roMessagePort")
    screen = PanelBounds(panel, {x: 0, y: 0, width: 100, height: 100})
    url = LayerDocument(panel, "")
    If url <> "" Then panel.overlay = HtmlLayer(url, screen, panel.overlayPort, panel.settings.rotation)
    If panel.overlay = invalid Then
        panel.overlayState = "error"
    Else If panel.overlay.Show() Then
        panel.overlayState = "loading"
    Else
        panel.overlayState = "error"
    End If
End Sub

Sub PanelHtmlFeedback(panel As Object)
    If panel.htmlPort <> invalid Then
        event = Wait(1, panel.htmlPort)
        If Type(event) = "roHtmlWidgetEvent" Then
            data = event.GetData()
            If data <> invalid Then
                If data.reason = "load-finished" Then
                    panel.state = "playing"
                    panel.retryAt = 0
                    panel.retryDelay = 3
                    If panel.settings.overlay <> "" Then panel.overlayState = "loaded"
                End If
                If data.reason = "load-error" Then
                    panel.state = "error"
                    panel.error = "The lower webpage could not load."
                    ScheduleVideoRetry(panel)
                End If
            End If
        End If
    End If
    If panel.overlayPort <> invalid Then
        event = Wait(1, panel.overlayPort)
        If Type(event) = "roHtmlWidgetEvent" Then
            data = event.GetData()
            If data <> invalid Then
                If data.reason = "load-finished" Then panel.overlayState = "loaded"
                If data.reason = "load-error" Then panel.overlayState = "error"
            End If
        End If
    End If
End Sub

Function StartPanel(panel As Object, position = -1 As Integer) As Boolean
    If not panel.ready Then Return false
    If panel.identUntil = 0 Then HideStartupCard(panel)
    panel.retryAt = 0
    panel.mediaCycle = ""
    If panel.base <> invalid Then panel.base.Hide()
    panel.base = invalid
    panel.htmlPort = invalid
    panel.error = ""
    panel.state = "starting"
    panel.loadAt = UpTime(0)
    If m.holding <> invalid Then m.holding.Hide()
    accepted = false
    If panel.source = "web" Then
        panel.video.StopClear()
        accepted = StartWebLayer(panel)
    Else If panel.source = "srt" Or panel.source = "rtsp" Then
        accepted = panel.video.PlayFile({Url: panel.url})
        If not accepted Then accepted = panel.video.PlayFile(panel.url)
    Else
        path = panel.baseline
        If panel.asset <> "" Then path = PanelAsset(panel, panel.asset)
        If panel.role = "leader" And (panel.source = "built-in" Or panel.source = "group") Then
            prefix = panel.baselinePrefix + "-" + panel.nativeLoop + "-"
            If panel.source = "group" Then prefix = "suite-play-" + panel.revision + "-"
            If position >= 0 Then
                clip = "base"
                If panel.source = "group" Then clip = panel.revision
                prefix = "suite-jump-" + clip + "-" + Mid(StrI(position), 2) + "-"
            End If
            panel.sequence = panel.sequence + 1
            accepted = StartLeaderCycle(panel.manager, panel.video, path, prefix, panel.sequence, position)
            If accepted Then panel.mediaCycle = prefix + Mid(StrI(panel.sequence), 2)
        Else
            accepted = panel.video.PlayFile({Filename: path})
        End If
    End If
    If not accepted Then
        panel.state = "error"
        panel.error = "The native renderer rejected this source."
        If panel.source = "srt" Then panel.error = "The native SRT source was rejected. Check the player SRT extension and the feed URL."
        If panel.source = "rtsp" Then panel.error = "The native RTSP source was rejected. Check the feed URL and video format."
        ScheduleVideoRetry(panel)
        Return false
    End If
    If PanelLiveSource(panel) Then RememberLiveSource(panel)
    If panel.source <> "web" Then RefreshOverlay(panel)
    Return true
End Function

Function CanRetryVideo(panel As Object) As Boolean
    If panel.settings.intent <> "auto" Then Return false
    If PanelLiveSource(panel) Then Return true
    Return panel.role <> "follower" And panel.settings.loop
End Function

Sub ScheduleVideoRetry(panel As Object)
    If not CanRetryVideo(panel) Then Return
    panel.retryAt = UpTime(0) + panel.retryDelay
    If panel.retryDelay < 24 Then panel.retryDelay = panel.retryDelay * 2
End Sub

Function ParseGroupJump(syncId As String) As Dynamic
    If Left(syncId, 11) <> "suite-jump-" Then Return invalid
    suffix = Mid(syncId, 12)
    splitAt = Instr(1, suffix, "-")
    If splitAt < 2 Then Return invalid
    clip = Left(suffix, splitAt - 1)
    If clip <> "base" And not SafeHex(clip, 24) Then Return invalid
    suffix = Mid(suffix, splitAt + 1)
    splitAt = Instr(1, suffix, "-")
    If splitAt < 2 Or splitAt > 9 Then Return invalid
    raw = Left(suffix, splitAt - 1)
    position = StrToI(raw)
    If position < 0 Or Mid(StrI(position), 2) <> raw Then Return invalid
    Return {clip: clip, position: position}
End Function

Sub PanelTick(panel As Object)
    CheckUpdateBoot()
    PanelRestart(panel)
    PanelHtmlFeedback(panel)
    now = UpTime(0)
    If m.clockWeb <> invalid And now >= panel.telemetryAt Then
        panel.telemetryAt = now + 1
        m.clockWeb.PostJsMessage({protocol: "start-syncplayer-playback-v1", status: FormatJson(PanelPlayback(panel)), version: m.version})
    End If
    If panel.state = "starting" And panel.loadAt > 0 And UpTime(0) > panel.loadAt + 20 Then
        panel.state = "error"
        panel.error = "The source did not report playback within 20 seconds."
        ScheduleVideoRetry(panel)
    End If
    If UpTime(0) < panel.readyAt Then Return
    If panel.identUntil = 0 Or now >= panel.identUntil Then HideStartupCard(panel)
    If panel.role = "follower" And not panel.localOverride Then Return
    If panel.retryAt > 0 And now >= panel.retryAt Then
        panel.retryAt = 0
        If CanRetryVideo(panel) Then
            LogEvent("NATIVE_VIDEO_RETRY", {source: panel.source})
            panel.video.StopClear()
            StartPanel(panel)
        End If
    End If
    If panel.role <> "follower" Then
        wake = invalid
        If panel.scheduled And panel.settings.scheduleenabled = true And panel.clock <> invalid Then
            If panel.clock.IsValid() Then wake = ScheduleAllows(panel.clock, panel.settings)
        End If
        ApplyScheduledPower(panel, wake)
    End If
    If not panel.autostart Then
        panel.autostart = true
        If panel.settings.intent = "auto" Then
            If panel.waiting Then
                panel.state = "waiting for peers"
            Else
                If PanelLiveSource(panel) Then PanelSignal(panel, "suite-stop-")
                StartPanel(panel)
            End If
        Else
            StopPanel(panel, panel.settings.intent = "blackout")
        End If
    End If
End Sub

Sub PanelFollow(panel As Object, event As Object)
    syncId = event.GetId()
    stamp = event.GetIsoTimestamp()
    If event.GetDomain() <> panel.settings.group Or Len(syncId) > 64 Or Len(stamp) = 0 Or Len(stamp) > 64 Then Return
    basePrefix = panel.baselinePrefix + "-" + panel.nativeLoop + "-"
    If Left(syncId, Len(basePrefix)) = basePrefix Or Left(syncId, 11) = "suite-play-" Or ParseGroupJump(syncId) <> invalid Then
        panel.groupCue = event
    Else If Left(syncId, 6) = "suite-" Then
        panel.groupCue = invalid
    End If
    If panel.localOverride Then Return
    If panel.scheduled And UpTime(0) >= panel.memberUntil Then Return
    If syncId = panel.syncId And stamp = panel.syncTime Then Return
    panel.syncId = syncId
    panel.syncTime = stamp
    If Left(syncId, 12) = "suite-pause-" Or Left(syncId, 13) = "suite-resume-" Then
        If PanelGroupMedia(panel) Then
            action = "pause"
            If Left(syncId, 13) = "suite-resume-" Then action = "resume"
            error = PanelTransport(panel, action, stamp)
            If error <> "" Then panel.error = error
        End If
        Return
    End If
    If Left(syncId, Len(panel.baselinePrefix) + 9) = panel.baselinePrefix + "-standby-" Then Return
    If Left(syncId, 11) = "suite-stop-" Or Left(syncId, 12) = "suite-black-" Then
        StopPanel(panel, Left(syncId, 12) = "suite-black-")
        Return
    End If
    prefix = panel.baselinePrefix + "-" + panel.nativeLoop + "-"
    baseline = Left(syncId, Len(prefix)) = prefix
    group = Left(syncId, 11) = "suite-play-" And Mid(syncId, 36, 1) = "-"
    jump = ParseGroupJump(syncId)
    position = -1
    If jump <> invalid Then
        baseline = jump.clip = "base"
        group = not baseline
        position = jump.position
    End If
    If not baseline And not group Then Return
    panel.revision = ""
    panel.asset = ""
    panel.source = "built-in"
    panel.name = panel.settings.presentationtitle
    path = panel.baseline
    If group Then
        revision = Mid(syncId, 12, 24)
        If jump <> invalid Then revision = jump.clip
        If not SafeHex(revision, 24) Then Return
        digest = ReadAsciiFile(panel.root + "library/prepared/" + revision + ".txt")
        path = PanelAsset(panel, digest)
        If path = "" Then
            StopPanel(panel, false)
            panel.error = "This player does not have the prepared revision."
            Return
        End If
        panel.revision = revision
        panel.asset = digest
        panel.source = "group"
        panel.name = "Distributed media"
    End If
    If panel.base <> invalid Then panel.base.Hide()
    panel.base = invalid
    panel.htmlPort = invalid
    If m.holding <> invalid Then m.holding.Hide()
    panel.state = "starting"
    panel.loadAt = UpTime(0)
    panel.mediaCycle = ""
    panel.error = ""
    If PlayNative(panel.video, path, event, position) Then
        panel.mediaCycle = syncId
    Else
        panel.state = "error"
    End If
    RefreshOverlay(panel)
End Sub

Sub PanelVideoEvent(panel As Object, code As Integer)
    LogEvent("NATIVE_VIDEO_EVENT", {code: code})
    If panel.source = "web" Then Return
    If code = 3 And panel.state = "starting" Then
        panel.state = "playing"
        panel.retryDelay = 3
    End If
    If code <> 8 Or (panel.state <> "playing" And panel.state <> "starting") Then Return
    If panel.source = "srt" Or panel.source = "rtsp" Then
        panel.state = "ended"
        panel.error = "The " + UCase(panel.source) + " stream ended or disconnected."
        ScheduleVideoRetry(panel)
    Else If panel.nativeLoop = "seamless" Then
        StopPanel(panel, false)
        LogEvent("SEAMLESS_MEDIA_ENDED", {})
    Else If panel.role <> "follower" And panel.settings.loop And panel.settings.intent = "auto" Then
        StartPanel(panel)
    Else
        StopPanel(panel, false)
    End If
End Sub

Sub CheckUpdateBoot()
    If m.updateDeadline = 0 Then Return
    If ReadAsciiFile(m.runtime + "healthy.txt") = "yes" Then
        m.updateDeadline = 0
    Else If UpTime(0) >= m.updateDeadline Then
        LogEvent("UPDATE_HEALTH_TIMEOUT", {})
        RebootSystem()
    End If
End Sub

Sub PanelRestart(panel As Object)
    If panel.rebootAt = 0 Or UpTime(0) < panel.rebootAt Then Return
    panel.rebootAt = 0
    change = panel.change
    panel.change = ""
    If change = "network" Then
        CommitPanelNetwork(panel)
    Else If change = "role-or-ptp" Or change = "app-update" Or change = "orientation" Then
        RebootSystem()
    Else If change = "video-mode" Then
        If panel.mode.SetMode(panel.settings.output) Then Return
        panel.settings.output = panel.mode.GetMode()
        SavePanel(panel, panel.settings)
        panel.error = "HDMI mode rejected. The previous mode was kept."
    End If
End Sub

Function ValidPanelGroup(value As Dynamic) As Boolean
    If not TextValue(value) Then Return false
    If Len(value) < 1 Or Len(value) > 48 Then Return false
    For i = 1 To Len(value)
        If Instr(1, "abcdefghijklmnopqrstuvwxyz0123456789-", Mid(value, i, 1)) = 0 Then Return false
    End For
    Return true
End Function

Function ValidPanelRect(bounds As Dynamic) As Boolean
    If Type(bounds) <> "roAssociativeArray" Then Return false
    For Each key In ["x", "y", "width", "height"]
        If not WholeNumber(bounds[key]) Then Return false
    End For
    Return bounds.x >= 0 And bounds.y >= 0 And bounds.width >= 5 And bounds.height >= 5 And bounds.x + bounds.width <= 100 And bounds.y + bounds.height <= 100
End Function

Function PanelSet(panel As Object, patch As Object) As String
    If panel.change <> "" Then Return "A device restart is already pending."
    nextSettings = ParseJson(FormatJson(panel.settings))
    For Each key In patch
        If key <> "selection" And key <> "loop" And key <> "intent" And nextSettings[key] <> invalid Then nextSettings[key] = patch[key]
    End For
    If nextSettings.role <> "leader" And nextSettings.role <> "follower" And nextSettings.role <> "standalone" Then Return "Invalid role."
    If nextSettings.role <> "standalone" And panel.address <> panel.expectedAddress Then Return "Restore the Configured Group IP in Network Settings First."
    If not TextValue(nextSettings.leader) Then Return "Invalid leader."
    If Len(nextSettings.leader) <> 1 Or Instr(1, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", nextSettings.leader) = 0 Then Return "Invalid leader."
    If nextSettings.role = "leader" And nextSettings.leader <> m.playerId Then Return "Select this player to act as leader."
    If nextSettings.role = "follower" And nextSettings.leader = m.playerId Then Return "Select a different player as leader."
    If not WholeNumber(nextSettings.domain) Or not WholeNumber(nextSettings.volume) Or not WholeNumber(nextSettings.interval) Then Return "Use whole numbers."
    If nextSettings.domain < 0 Or nextSettings.domain > 127 Or nextSettings.volume < 0 Or nextSettings.volume > 100 Then Return "Setting out of range."
    If not ValidPanelGroup(nextSettings.group) Or not ValidPanelRect(nextSettings.rect) Or not BooleanValue(nextSettings.muted) Then Return "Invalid group or video window."
    If nextSettings.output <> "3840x2160x50p" And nextSettings.output <> "1920x1080x50p" Then Return "Unsupported HDMI mode."
    If not ValidRotation(nextSettings.rotation) Then Return "Choose 0°, 90°, 180° or 270°."
    If not BooleanValue(nextSettings.audioenabled) Then Return "Choose Whether to Enable HDMI Audio."
    If not BooleanValue(nextSettings.cecremote) Then Return "Choose Whether to Enable CEC Remote Playback."
    If not TextValue(nextSettings.presentationtitle) Then Return "Enter a Presentation Title."
    If Len(nextSettings.presentationtitle) < 1 Or Len(nextSettings.presentationtitle) > 100 Then Return "Enter a Presentation Title of 1 to 100 Characters."
    If panel.scheduled And (not BooleanValue(nextSettings.scheduleenabled) Or MinuteOfDay(nextSettings.on) < 0 Or MinuteOfDay(nextSettings.off) <= MinuteOfDay(nextSettings.on)) Then Return "Invalid display schedule."
    If nextSettings.overlay <> "" And not PanelWebUrl(nextSettings.overlay) Then Return "Invalid overlay URL."
    If nextSettings.ntp <> panel.settings.ntp Or nextSettings.interval <> panel.settings.interval Then
        If nextSettings.interval <> 0 And (nextSettings.interval < 120 Or nextSettings.interval > 86400) Then Return "Invalid NTP interval."
        If nextSettings.ntp <> panel.settings.ntp Then
            If nextSettings.ntp <> "" And Left(nextSettings.ntp, 6) <> "ntp://" Then Return "Invalid NTP server."
            If not panel.network.SetTimeServer(nextSettings.ntp) Then Return "The player rejected the NTP server."
        End If
        If nextSettings.interval <> panel.settings.interval Then
            If not panel.network.SetTimeServerIntervalSeconds(nextSettings.interval) Then Return "The player rejected the NTP interval."
        End If
        If not panel.network.Apply() Then Return "The player could not apply the NTP settings."
    End If
    old = panel.settings
    If nextSettings.role <> old.role Or nextSettings.domain <> old.domain Or nextSettings.group <> old.group Or nextSettings.leader <> old.leader Then
        kind = ""
        If Type(nextSettings.selection) = "roAssociativeArray" Then kind = nextSettings.selection.kind
        If kind <> "srt" And kind <> "rtsp" And kind <> "web" Then nextSettings.selection = {kind: "built-in"}
        change = "role-or-ptp"
    Else If nextSettings.rotation <> old.rotation Then
        change = "orientation"
    Else If nextSettings.output <> old.output Then
        change = "video-mode"
    Else
        change = ""
    End If
    If change = "" Then
        If not ApplyVolume(panel, nextSettings) Then Return "The player rejected the volume setting."
    End If
    If not SavePanel(panel, nextSettings) Then
        If change = "" Then ApplyVolume(panel, old)
        Return "Settings could not be written."
    End If
    panel.settings = nextSettings
    If panel.source = "built-in" Or panel.source = "built-in-local" Then panel.name = nextSettings.presentationtitle
    If change <> "" Then
        panel.change = change
        panel.rebootAt = UpTime(0) + 3
        Return ""
    End If
    If FormatJson(old.rect) <> FormatJson(nextSettings.rect) And panel.video <> invalid Then
        panel.video.SetRectangle(PanelBounds(panel, nextSettings.rect))
        If panel.base <> invalid And panel.source = "web" Then StartPanel(panel)
    End If
    If nextSettings.overlay <> old.overlay Then RefreshOverlay(panel)
    Return ""
End Function

Function PanelCommand(panel As Object, action As String, body As Object) As String
    If action = "ota-restart" Then
        If panel.change <> "" Then Return "A Device Restart Is Already Pending."
        panel.change = "app-update"
        panel.rebootAt = UpTime(0) + 3
        Return ""
    Else If action = "probe" Then
        If VerifiedAsset(panel, body.asset) Then Return ""
        Return "The native file probe rejected this media."
    Else If action = "settings" Then
        Return PanelSet(panel, body)
    Else If action = "network" Then
        If panel.change <> "" Then Return "A Device Restart Is Already Pending."
        If body.mode <> "dhcp" And body.mode <> "static" Then Return "Invalid Ethernet Mode."
        If body.mode = "static" And panel.role <> "standalone" And body.address <> panel.expectedAddress Then Return "Use the Configured Group IP for a Grouped Player."
        panel.networkNext = body
        panel.change = "network"
        panel.rebootAt = UpTime(0) + 3
        Return ""
    Else If action = "peer-audio" Then
        If panel.role <> "follower" Or not panel.ready Or UpTime(0) >= panel.memberUntil Then Return "Group Audio Requires an Active Follower."
        If not BooleanValue(body.enabled) Or not SafeHex(body.revision, 24) Then Return "Invalid Group Audio Request."
        If body.revision = panel.settings.audiorevision Then Return ""
        Return PanelSet(panel, {audioenabled: body.enabled, audiorevision: body.revision})
    Else If action = "membership" Then
        If panel.role <> "follower" Or not BooleanValue(body.admitted) Then Return "Invalid follower membership."
        If body.admitted Then
            panel.memberUntil = UpTime(0) + 16
            If panel.ready Then ApplyScheduledPower(panel, body.wake)
        Else
            panel.memberUntil = 0
            panel.before = invalid
            If panel.ready And PanelGroupMedia(panel) And panel.state <> "outside group" Then
                StopPanel(panel, true)
                panel.state = "outside group"
            End If
        End If
        Return ""
    End If
    If not panel.ready Then Return "Native playback is still starting."
    If panel.change <> "" Then Return "The device is about to restart."
    If action = "ident" Then
        If not WholeNumber(body.seconds) Then Return "Enter an IDENT Duration Between 0 and 30 Seconds."
        If body.seconds < 0 Or body.seconds > 30 Then Return "Enter an IDENT Duration Between 0 and 30 Seconds."
        If body.seconds = 0 Then
            HideStartupCard(panel)
        Else
            If not ShowStartupCard(panel) Then Return "Could Not Show the IDENT Screen."
            panel.identUntil = UpTime(0) + body.seconds
        End If
        Return ""
    End If
    If action = "snapshot" Or action = "thumbnail" Then
        capture = {filename: panel.root + "suite-snapshot.jpg", width: 960, height: 540, filetype: "JPEG", quality: 80, async: 0}
        If action = "thumbnail" Then
            capture.filename = panel.root + "suite-thumbnail.jpg"
            capture.width = 160
            capture.height = 90
            capture.quality = 45
        End If
        If not panel.mode.Screenshot(capture) Then Return "Could Not Capture the Player Output."
        Return ""
    End If
    If action = "display-power" Then
        If panel.cec = invalid Then Return "HDMI-CEC Is Unavailable on This Player."
        If not BooleanValue(body.wake) Then Return "Choose Power On or Standby."
        SendDisplayCec(panel.cec, body.wake)
        panel.cecRequest = "standby"
        If body.wake Then panel.cecRequest = "on"
        Return ""
    End If
    If action = "follow" Then
        If panel.role <> "follower" Or not panel.localOverride Then Return "This Player Is Already Following Its Group."
        saved = ParseJson(FormatJson(panel.settings))
        saved.selection = {kind: "built-in"}
        saved.intent = "auto"
        If not SavePanel(panel, saved) Then Return "The startup selection could not be saved."
        StopPanel(panel, false)
        panel.settings = saved
        panel.localOverride = false
        panel.source = "built-in"
        panel.name = saved.presentationtitle
        panel.url = ""
        panel.syncId = ""
        panel.syncTime = ""
        If panel.groupCue <> invalid Then PanelFollow(panel, panel.groupCue)
        Return ""
    End If
    If action = "pause" Or action = "resume" Then
        playback = PanelPlayback(panel)
        If not playback.pausable Then Return "Play an MP4 to use this transport control."
        If action = "pause" And panel.state = "paused" Then Return ""
        If action = "resume" And panel.state = "playing" Then Return ""
        stamp = ""
        If playback.synced Then
            panel.sequence = panel.sequence + 1
            event = panel.manager.Synchronize("suite-" + action + "-" + Mid(StrI(panel.sequence), 2), 500)
            If event = invalid Then Return "The native player could not schedule the transport command."
            stamp = event.GetIsoTimestamp()
            If stamp = "" Then Return "The native transport timestamp is unavailable."
        End If
        Return PanelTransport(panel, action, stamp)
    End If
    If action = "seek" Or action = "group-seek" Then
        playback = PanelPlayback(panel)
        If not WholeNumber(body.positionms) Then Return "Use a whole-number position in milliseconds."
        If playback.durationms = invalid Or body.positionms < 0 Then Return "Seek to a position inside the current clip."
        If body.positionms >= playback.durationms Then Return "Seek to a position inside the current clip."
        If action = "group-seek" Then
            If panel.role <> "leader" Or not playback.synced Or not playback.pausable Or panel.manager = invalid Then Return "Play a Synced MP4 to Move the Group Playhead."
            panel.video.StopClear()
            panel.retryDelay = 3
            If not StartPanel(panel, body.positionms) Then Return panel.error
            Return ""
        End If
        If not playback.seekable Then Return "Play a local MP4 to use the playhead."
        If not panel.video.Seek(body.positionms) Then Return "The native player rejected the seek."
        Return ""
    End If
    If action = "colour" Then
        For Each key In ["brightness", "hue", "saturation"]
            If not WholeNumber(body[key]) Then Return "Video colour values must be whole numbers."
            If body[key] < -1000 Or body[key] > 1000 Then Return "Video colour value out of range."
        End For
        values = {Brightness: body.brightness, Hue: body.hue, Saturation: body.saturation, Contrast: 0}
        If not panel.video.AdjustVideoColor(values) Then Return "The player rejected the colour adjustment."
        panel.colour = values
        Return ""
    End If
    If action = "stop" Or action = "blackout" Then
        panel.waiting = false
        panel.settings.intent = action
        If not SavePanel(panel, panel.settings) Then Return "The playback preference could not be saved."
        prefix = "suite-stop-"
        If action = "blackout" Then prefix = "suite-black-"
        PanelSignal(panel, prefix)
        StopPanel(panel, action = "blackout")
        Return ""
    Else If action = "loop" Then
        If not BooleanValue(body.enabled) Then Return "Invalid loop setting."
        panel.settings.loop = body.enabled
        If not SavePanel(panel, panel.settings) Then Return "The loop preference could not be saved."
        Return ""
    End If
    If action = "arm" Then
        If not panel.waiting Or panel.source <> "group" Or body.revision <> panel.revision Then Return "That revision is not waiting."
        panel.waiting = false
    Else If action = "source" Then
        If body.type = "web" Then
            If not PanelWebUrl(body.url) Then Return "Invalid webpage URL."
        Else If body.type = "srt" Then
            If not PanelSrtUrl(body.url) Then Return "Invalid SRT URL."
        Else If body.type = "rtsp" Then
            If not PanelRtspUrl(body.url) Then Return "Invalid RTSP URL."
        Else
            Return "Unsupported source."
        End If
        panel.waiting = false
        PanelSignal(panel, "suite-stop-")
        SetLiveSource(panel, body.type, body.url, body.name)
        panel.localOverride = panel.role = "follower"
    Else If action = "play" Then
        If panel.role = "follower" Then Return "The configured leader controls group playback."
        If body.type <> "built-in" And body.type <> "built-in-local" And body.type <> "group" And body.type <> "preview" And body.type <> "local" Then Return "Unsupported source."
        If body.type = "group" And (not SafeHex(body.revision, 24) Or panel.role <> "leader") Then Return "Invalid group revision."
        builtIn = body.type = "built-in" Or body.type = "built-in-local"
        ephemeral = body.type = "preview" Or body.type = "built-in-local"
        If not builtIn And not VerifiedAsset(panel, body.asset) Then Return "The native file probe rejected this media."
        panel.waiting = false
        If ephemeral Or body.type = "local" Then PanelSignal(panel, "suite-stop-")
        panel.source = body.type
        panel.asset = ""
        panel.revision = ""
        panel.url = ""
        panel.name = panel.settings.presentationtitle
        If not builtIn Then
            panel.asset = body.asset
            panel.name = body.name
            If body.type = "group" Then panel.revision = body.revision
        End If
        If not ephemeral Then panel.settings.selection = {kind: panel.source, asset: panel.asset, revision: panel.revision, name: panel.name}
    Else If action <> "restart" Or panel.waiting Or (panel.role = "follower" And not PanelLiveSource(panel)) Then
        Return "This player cannot perform that command."
    End If
    panel.settings.intent = "auto"
    panel.autostart = true
    panel.retryDelay = 3
    If not StartPanel(panel) Then Return panel.error
    If (action = "play" And body.type <> "preview" And body.type <> "built-in-local") Or action = "restart" Then
        If not SavePanel(panel, panel.settings) Then Return "Playback started but the selection could not be saved."
    End If
    Return ""
End Function

Sub HandlePanelRequest(panel As Dynamic, request As Object, response As Object)
    response.ok = "no"
    If panel = invalid Then
        response.error = "Native setup is still starting."
        Return
    End If
    If request.action = "status" Then
        response.ok = "yes"
    Else If TextValue(request.data) Then
        body = ParseJson(request.data)
        If Type(body) = "roAssociativeArray" Then
            problem = PanelCommand(panel, request.action, body)
            If problem = "" Then
                response.ok = "yes"
            Else
                response.error = problem
            End If
        End If
    End If
    response.status = FormatJson(PanelStatus(panel))
End Sub

Function ValidConfig(config As Dynamic) As Boolean
    If Type(config) <> "roAssociativeArray" Then Return false
    If not WholeNumber(config.schema_version) Then Return false
    If config.schema_version <> 1 Then Return false
    If not WholeNumber(config.ptp_domain) Then Return false
    If config.ptp_domain < 0 Or config.ptp_domain > 127 Then Return false
    If not BooleanValue(config.apply_ptp_settings) Or not BooleanValue(config.enable_genlock) Then Return false
    If not TextValue(config.loop_mode) Then Return false
    If config.loop_mode <> "seamless" And config.loop_mode <> "reschedule" Then Return false
    If not TextValue(config.group_id) Or not TextValue(config.leader_id) Then Return false
    If Len(config.group_id) < 1 Or Len(config.group_id) > 48 Then Return false
    For index = 1 To Len(config.group_id)
        If Instr(1, "abcdefghijklmnopqrstuvwxyz0123456789-", Mid(config.group_id, index, 1)) = 0 Then Return false
    End For
    If Type(config.players) <> "roAssociativeArray" Then Return false
    playerCount = 0
    ids = {}
    For Each address In config.players
        playerId = config.players[address]
        If not TextValue(playerId) Then Return false
        If Len(playerId) <> 1 Then Return false
        If Instr(1, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", playerId) = 0 Then Return false
        If ids[playerId] <> invalid Then Return false
        ids[playerId] = true
        playerCount = playerCount + 1
    End For
    If playerCount < 2 Or playerCount > 26 Then Return false
    If Len(config.leader_id) <> 1 Then Return false
    If Instr(1, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", config.leader_id) = 0 Then Return false
    If ids[config.leader_id] = invalid Then Return false
    If config.card_player_id = invalid Then
        Return config.output_mode = invalid And config.static_ipv4 = invalid And config.display_schedule = invalid
    End If
    If not TextValue(config.card_player_id) Or not TextValue(config.output_mode) Then Return false
    If Len(config.card_player_id) <> 1 Or Instr(1, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", config.card_player_id) = 0 Then Return false
    If ids[config.card_player_id] = invalid Then Return false
    If config.output_mode <> "3840x2160x50p" And config.output_mode <> "1920x1080x50p" Then Return false
    If config.display_schedule <> invalid Then
        If not ValidDisplaySchedule(config.display_schedule) Or config.loop_mode <> "reschedule" Then Return false
    End If
    Return true
End Function

Function ValidDisplaySchedule(schedule As Dynamic) As Boolean
    If Type(schedule) <> "roAssociativeArray" Then Return false
    If not TextValue(schedule.timezone) Then Return false
    If schedule.timezone <> "Australia/Sydney" Then Return false
    If not TextValue(schedule.on) Or not TextValue(schedule.off) Then Return false
    onMinute = MinuteOfDay(schedule.on)
    offMinute = MinuteOfDay(schedule.off)
    Return onMinute >= 0 And offMinute > onMinute
End Function

Function MinuteOfDay(value As String) As Integer
    If Len(value) <> 5 Or Mid(value, 3, 1) <> ":" Then Return -1
    For Each index In [1, 2, 4, 5]
        If Instr(1, "0123456789", Mid(value, index, 1)) = 0 Then Return -1
    End For
    hours = StrToI(Left(value, 2))
    minutes = StrToI(Right(value, 2))
    If hours > 23 Or minutes > 59 Then Return -1
    Return hours * 60 + minutes
End Function

Function ScheduleAllows(clock As Dynamic, schedule As Object) As Boolean
    If clock = invalid Then Return false
    If not clock.IsValid() Then Return false
    localTime = clock.GetZoneDateTime("AEST")
    If localTime = invalid Then Return false
    current = localTime.GetHour() * 60 + localTime.GetMinute()
    Return current >= MinuteOfDay(schedule.on) And current < MinuteOfDay(schedule.off)
End Function

Sub ApplyScheduledPower(panel As Object, wake As Dynamic)
    If not BooleanValue(wake) Then
        panel.before = invalid
        Return
    End If
    If BooleanValue(panel.before) Then
        If panel.before = wake Then Return
    End If
    panel.before = wake
    panel.screens = wake
    If panel.cec <> invalid Then SendDisplayCec(panel.cec, wake)
End Sub

Sub SendDisplayCec(cec As Object, wake As Boolean)
    ' Low nibble 0 addresses the TV. BrightSign supplies the initiator nibble.
    packet = CreateObject("roByteArray")
    If wake Then
        packet.FromHexString("0004") ' Image View On
        cec.SendRawMessage(packet)
        packet = CreateObject("roByteArray")
        packet.FromHexString("0F820000") ' Active Source, with the physical address filled by BrightSign
    Else
        packet.FromHexString("0036") ' Standby
    End If
    cec.SendRawMessage(packet)
    LogEvent("CEC_COMMAND_SENT", {wake: wake})
End Sub

Function ShowHolding(mode As Object, path As String, rotation = 0 As Integer) As Dynamic
    ' Keep the graphics below the hardware video. It remains visible whenever the video plane is clear.
    If not mode.SetGraphicsZOrder("back") Then
        LogEvent("HOLDING_GRAPHICS_ORDER_REJECTED", {})
        Return invalid
    End If
    bounds = CreateObject("roRectangle", 0, 0, mode.GetResX(), mode.GetResY())
    holding = CreateObject("roImageWidget", bounds)
    If holding = invalid Then
        LogEvent("HOLDING_WIDGET_UNAVAILABLE", {})
        Return invalid
    End If
    If rotation <> 0 Then
        If not holding.SetTransform(GraphicsRotation(rotation)) Then LogEvent("HOLDING_ROTATION_REJECTED", {rotation: rotation})
    End If
    If not holding.SetDefaultMode(1) Or not holding.DisplayFile(path) Or not holding.Show() Then
        LogEvent("HOLDING_IMAGE_REJECTED", {path: path})
        Return invalid
    End If
    Return holding
End Function

Function ConfigureCardAudio(video As Object) As Boolean
    audio = CreateObject("roAudioOutput", "hdmi")
    If audio <> invalid Then
        If video.SetPcmAudioOutputs(audio) Then Return true
    End If
    LogEvent("AUDIO_CONFIGURATION_REJECTED", {})
    Return false
End Function

Function WholeNumber(value As Dynamic) As Boolean
    kind = Type(value)
    Return kind = "Integer" Or kind = "roInt" Or kind = "roInteger"
End Function

Function BooleanValue(value As Dynamic) As Boolean
    kind = Type(value)
    Return kind = "Boolean" Or kind = "roBoolean"
End Function

Function TextValue(value As Dynamic) As Boolean
    kind = Type(value)
    Return kind = "String" Or kind = "roString"
End Function

Function WaitForAddress(network As Object, players As Object, cardId As Dynamic, port As Object) As String
    LogEvent("WAITING_FOR_ETH0", {})
    address = ""
    For attempt = 1 To 45
        current = network.GetCurrentConfig()
        If Type(current) = "roAssociativeArray" Then
            If TextValue(current.ip4_address) Then
                address = current.ip4_address
                If current.link = true And address <> "" And (cardId <> invalid Or players[address] <> invalid) Then Return address
            End If
        End If
        Wait(1000, port)
    End For
    LogEvent("ETH0_ADDRESS_UNASSIGNED", {last_ip: address})
    Return ""
End Function

Function EnsurePtp(config As Object) As Boolean
    registry = CreateObject("roRegistrySection", "networking")
    If registry = invalid Then
        LogEvent("REGISTRY_UNAVAILABLE", {})
        Return false
    End If
    wantedDomain = Mid(StrI(config.ptp_domain), 2)
    currentDomain = registry.Read("ptp_domain")
    currentInterface = registry.Read("ptp_interface")
    interfaceMatches = (currentInterface = "" Or currentInterface = "eth0")
    If currentDomain = wantedDomain And interfaceMatches Then Return true

    If not config.apply_ptp_settings Then
        LogEvent("PTP_SETUP_REQUIRED", {current_domain: currentDomain, current_interface: currentInterface, requested_domain: wantedDomain})
        Return false
    End If
    LogEvent("PTP_SETUP", {previous_domain: currentDomain, previous_interface: currentInterface, requested_domain: wantedDomain})
    If not interfaceMatches Then
        If not registry.Write("ptp_interface", "eth0") Then
            LogEvent("PTP_INTERFACE_WRITE_FAILED", {})
            Return false
        End If
    End If
    If currentDomain <> wantedDomain Then
        If not registry.Write("ptp_domain", wantedDomain) Then
            LogEvent("PTP_DOMAIN_WRITE_FAILED", {})
            Return false
        End If
    End If
    If not registry.Flush() Then
        LogEvent("PTP_FLUSH_FAILED", {})
        Return false
    End If
    LogEvent("PTP_REBOOT", {})
    RebootSystem()
    Return false
End Function

Function SetNativeLeader(manager As Object, device As Object, leader As Boolean) As Boolean
    If not device.HasFeature("FindMemberFunction") Then Return manager.SetAsLeader(leader)
    If FindMemberFunction(manager, "SetAsLeader") <> invalid Then Return manager.SetAsLeader(leader)
    ' The vendor example uses this alternative name, without a return signature.
    If FindMemberFunction(manager, "SetLeaderMode") = invalid Then Return false
    manager.SetLeaderMode(leader)
    current = manager.GetCurrentConfig()
    If current = invalid Then Return false
    expected = 0
    If leader Then expected = 1
    LogEvent("SYNC_ROLE_EXAMPLE_METHOD", {leader: leader})
    Return current.leader = expected
End Function

Function StartLeaderCycle(manager As Object, video As Object, path As String, prefix As String, sequence As Integer, position = -1 As Integer) As Boolean
    syncId = prefix + Mid(StrI(sequence), 2)
    event = manager.Synchronize(syncId, 500)
    If event = invalid Then
        LogEvent("SYNC_SCHEDULE_FAILED", {sync_id: syncId})
        Return false
    End If
    Return PlayNative(video, path, event, position)
End Function

Function PlayNative(video As Object, path As String, event As Object, position = -1 As Integer) As Boolean
    stamp = event.GetIsoTimestamp()
    If position >= 0 And stamp <> "" Then
        origin = CreateObject("roDateTime")
        If origin = invalid Then Return false
        If not origin.FromIsoString(stamp) Then Return false
        origin.SubtractMilliseconds(position)
        stamp = origin.ToIsoString()
    End If
    params = {
        Filename: path
        SyncDomain: event.GetDomain()
        SyncId: event.GetId()
        SyncIsoTimestamp: stamp
    }
    If params.SyncIsoTimestamp = "" Then
        LogEvent("SYNC_TIMESTAMP_MISSING", {sync_id: params.SyncId})
        Return false
    End If

    accepted = video.PlayFile(params)
    fields = {sync_id: params.SyncId, native_timestamp: params.SyncIsoTimestamp}
    If accepted Then
        LogEvent("NATIVE_PLAY_REQUESTED", fields)
    Else
        LogEvent("NATIVE_PLAY_REJECTED", fields)
    End If
    Return accepted
End Function

Sub LogEvent(eventName As String, fields As Object)
    fields.app = "Start SyncPlayer"
    fields.version = m.version
    fields.event = eventName
    fields.player_id = m.playerId
    line = FormatJson(fields)
    Print line
    If m.systemLog <> invalid Then m.systemLog.SendLine(line)
End Sub
