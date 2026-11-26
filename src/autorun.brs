Sub Main()
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

    address = WaitForAddress(network, config.players, port)
    If address = "" Then Return

    m.playerId = config.players[address]
    targetMode = "1920x1080x60p"
    mediaName = "FrameCounter_" + m.playerId + ".mp4"
    contentId = "counter-r1"
    If cardId <> invalid Then
        If cardId <> m.playerId Then
            LogEvent("WRONG_PLAYER_CARD", {card_id: cardId, ip: address})
            Return
        End If
        targetMode = config.output_mode
        mediaName = "Presentation_" + m.playerId + ".mp4"
        contentId = "presentation-r1"
    End If
    mediaPath = root + "media/" + mediaName
    panel = NewPanel(config, device, mode, network, clock, root, address, targetMode, mediaPath, contentId, port)
    m.panel = panel
    m.clock = clock
    If scheduled And cardId = m.playerId And clock <> invalid Then
        If ReadAsciiFile(root + "clock/credentials.json") <> "" Then
            m.clockWeb = CreateObject("roNodeJs", root + "clock/server.js", {message_port: port, arguments: [address]})
            If m.clockWeb = invalid Then LogEvent("WEB_INTERFACE_UNAVAILABLE", {})
        End If
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
        If previousMode <> targetMode Then
            m.holding = invalid
            m.holding = ShowHolding(mode, root + "media/HOLDING.jpeg")
        End If
        If not ConfigureCardAudio(video, panel.role <> "follower") Then Return
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
        If panel.cec = invalid Then LogEvent("CEC_UNAVAILABLE", {})
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
    settings = {role: "follower", leader: config.leader_id, domain: config.ptp_domain, group: config.group_id, output: target, volume: 100, muted: false, rect: {x: 0, y: 0, width: 100, height: 100}, overlay: "", loop: true, intent: "auto", selection: {kind: "built-in"}}
    If m.playerId = config.leader_id Then settings.role = "leader"
    scheduled = config.display_schedule <> invalid
    If scheduled Then
        settings.on = config.display_schedule.on
        settings.off = config.display_schedule.off
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
    config.group_id = settings.group
    config.ptp_domain = settings.domain
    config.leader_id = settings.leader
    settings.ntp = network.GetTimeServer()
    settings.interval = network.GetTimeServerIntervalSeconds()
    panel = {settings: settings, registry: registry, role: settings.role, address: address, root: root, mode: mode, network: network, clock: clock, port: port, model: device.GetModel(), firmware: device.GetVersion(), serial: device.GetDeviceUniqueId(), defaultMode: target, baseline: path, baselinePrefix: contentId, nativeLoop: config.loop_mode, scheduled: scheduled, manager: invalid, video: invalid, cec: invalid, ready: false, screens: false, before: invalid, warmUntil: 0, rebootAt: 0, change: "", sequence: 0, syncId: "", syncTime: "", state: "booting", error: "", asset: "", revision: "", name: "Built-in presentation", source: "built-in", url: "", base: invalid, overlay: invalid, htmlPort: invalid, overlayPort: invalid, overlayState: "off", loadAt: 0}
    RestoreSelection(panel)
    panel.waiting = panel.role = "leader" And panel.source = "group" And panel.settings.intent = "auto"
    panel.colour = {brightness: 0, hue: 0, saturation: 0}
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
    data = {playerid: m.playerId, role: panel.role, leader: panel.settings.leader, group: panel.settings.group, domain: panel.settings.domain, output: panel.mode.GetMode(), requestedoutput: panel.settings.output, volume: panel.settings.volume, muted: panel.settings.muted, state: panel.state, error: panel.error, source: panel.source, asset: panel.asset, revision: panel.revision, name: panel.name, loop: panel.settings.loop, display: panel.screens, waiting: panel.waiting And panel.warmUntil = 0, on: panel.settings.on, off: panel.settings.off, rect: panel.settings.rect, overlay: panel.settings.overlay <> "", overlaystate: panel.overlayState, ntp: panel.settings.ntp, interval: panel.settings.interval, firmware: panel.firmware, model: panel.model, serial: panel.serial, uptime: UpTime(0), pending: panel.change, version: "0.2.2"}
    data.colour = panel.colour
    If Type(panel.settings.selection) = "roAssociativeArray" Then data.savedasset = panel.settings.selection.asset
    If panel.clock <> invalid Then
        data.clockvalid = panel.clock.IsValid()
        If panel.scheduled Then
            info = panel.clock.GetLastNetworkTimeResult()
            If info <> invalid Then data.ntpresult = info
        End If
    End If
    If panel.video <> invalid And (panel.state = "playing" Or panel.state = "starting") And panel.source <> "web" Then
        data.positionms = panel.video.GetPlaybackPosition()
        data.durationms = panel.video.GetDuration()
    End If
    Return data
End Function

Function PanelBounds(panel As Object, bounds As Object) As Object
    width = panel.mode.GetResX()
    height = panel.mode.GetResY()
    Return CreateObject("roRectangle", Int(width * bounds.x / 100), Int(height * bounds.y / 100), Int(width * bounds.width / 100), Int(height * bounds.height / 100))
End Function

Function ApplyVolume(panel As Object, settings As Object) As Boolean
    If panel.video = invalid Then Return true
    volume = settings.volume
    If settings.muted Or panel.role = "follower" Then volume = 0
    Return panel.video.SetVolume(volume)
End Function

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
        If panel.screens And m.holding <> invalid Then m.holding.Show()
        panel.state = "idle"
        RefreshOverlay(panel)
    End If
End Sub

Function PanelWebUrl(value As Dynamic) As Boolean
    If not TextValue(value) Then Return false
    Return Len(value) <= 1024 And (Left(value, 7) = "http://" Or Left(value, 8) = "https://")
End Function

Function HtmlLayer(url As String, bounds As Object, port As Object, transparent As Boolean) As Dynamic
    options = {url: url, port: port, nodejs_enabled: false, brightsign_js_objects_enabled: false, security_params: {websecurity: true, insecure_https_enabled: false}, pcm_audio_outputs: []}
    If transparent Then options.user_stylesheet = "data:text/css,html%2Cbody%7Bbackground-color%3Atransparent%20%21important%3B%7D"
    Return CreateObject("roHtmlWidget", bounds, options)
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
        encode = CreateObject("roUrlTransfer")
        If encode = invalid Then Return false
        url = "file:/" + panel.root + "clock/layer.html?base=" + encode.Escape(panel.url) + "&overlay=" + encode.Escape(panel.settings.overlay)
        rect = panel.settings.rect
        url = url + "&rect=" + encode.Escape(FormatJson(rect))
        bounds = PanelBounds(panel, {x: 0, y: 0, width: 100, height: 100})
        panel.overlayState = "loading"
    End If
    panel.base = HtmlLayer(url, bounds, panel.htmlPort, false)
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
    If panel.overlay <> invalid And panel.overlayUrl = panel.settings.overlay And panel.screens And panel.state <> "blackout" Then Return
    If panel.overlay <> invalid Then panel.overlay.Hide()
    panel.overlay = invalid
    panel.overlayPort = invalid
    panel.overlayState = "off"
    If not panel.screens Or panel.state = "blackout" Or not PanelWebUrl(panel.settings.overlay) Then Return
    If not panel.graphicsFront Then
        panel.overlayState = "graphics-order-error"
        Return
    End If
    If m.holding <> invalid Then m.holding.Hide()
    panel.overlayUrl = panel.settings.overlay
    panel.overlayPort = CreateObject("roMessagePort")
    screen = PanelBounds(panel, {x: 0, y: 0, width: 100, height: 100})
    panel.overlay = HtmlLayer(panel.settings.overlay, screen, panel.overlayPort, true)
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
                    If panel.settings.overlay <> "" Then panel.overlayState = "loaded"
                End If
                If data.reason = "load-error" Then
                    panel.state = "error"
                    panel.error = "The lower webpage could not load."
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

Function StartPanel(panel As Object) As Boolean
    If not panel.ready Or not panel.screens Then Return false
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
    Else If panel.source = "srt" Then
        accepted = panel.video.PlayFile({Url: panel.url})
        If not accepted Then accepted = panel.video.PlayFile(panel.url)
    Else
        path = panel.baseline
        If panel.asset <> "" Then path = PanelAsset(panel, panel.asset)
        If panel.role = "leader" And (panel.source = "built-in" Or panel.source = "group") Then
            prefix = panel.baselinePrefix + "-" + panel.nativeLoop + "-"
            If panel.source = "group" Then prefix = "suite-play-" + panel.revision + "-"
            panel.sequence = panel.sequence + 1
            accepted = StartLeaderCycle(panel.manager, panel.video, path, prefix, panel.sequence)
        Else
            accepted = panel.video.PlayFile({Filename: path})
        End If
    End If
    If not accepted Then
        panel.state = "error"
        panel.error = "The native renderer rejected this source."
        If panel.source = "srt" Then panel.error = "The native SRT source was rejected. Check the player SRT extension and the feed URL."
        Return false
    End If
    If panel.source <> "web" Then RefreshOverlay(panel)
    Return true
End Function

Sub PanelTick(panel As Object)
    PanelRestart(panel)
    PanelHtmlFeedback(panel)
    If panel.state = "starting" And panel.loadAt > 0 And UpTime(0) > panel.loadAt + 20 Then
        panel.state = "error"
        panel.error = "The source did not report playback within 20 seconds."
    End If
    If panel.role = "follower" Or UpTime(0) < panel.readyAt Then Return
    allowed = true
    If panel.scheduled Then allowed = ScheduleAllows(panel.clock, panel.settings)
    If panel.before = invalid Or panel.before <> allowed Then
        panel.before = allowed
        panel.screens = allowed
        If allowed Then
            PanelSignal(panel, panel.baselinePrefix + "-wake-")
            SetDisplayState(panel.video, panel.cec, true)
            panel.warmUntil = UpTime(0) + 8
            If not panel.scheduled Then panel.warmUntil = UpTime(0)
        Else
            PanelSignal(panel, panel.baselinePrefix + "-standby-")
            SetDisplayState(panel.video, panel.cec, false)
            StopPanel(panel, true)
            panel.state = "standby"
            panel.warmUntil = 0
        End If
    End If
    If panel.warmUntil > 0 And UpTime(0) >= panel.warmUntil Then
        panel.warmUntil = 0
        If panel.settings.intent = "auto" Then
            If panel.waiting Then
                panel.state = "waiting for peers"
            Else
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
    If syncId = panel.syncId And stamp = panel.syncTime Then Return
    panel.syncId = syncId
    panel.syncTime = stamp
    If Left(syncId, Len(panel.baselinePrefix) + 9) = panel.baselinePrefix + "-standby-" Then
        panel.screens = false
        SetDisplayState(panel.video, panel.cec, false)
        StopPanel(panel, true)
        panel.state = "standby"
        Return
    End If
    If Left(syncId, 11) = "suite-stop-" Or Left(syncId, 12) = "suite-black-" Then
        StopPanel(panel, Left(syncId, 12) = "suite-black-")
        Return
    End If
    wake = Left(syncId, Len(panel.baselinePrefix) + 6) = panel.baselinePrefix + "-wake-"
    prefix = panel.baselinePrefix + "-" + panel.nativeLoop + "-"
    baseline = Left(syncId, Len(prefix)) = prefix
    group = Left(syncId, 11) = "suite-play-" And Mid(syncId, 36, 1) = "-"
    If not wake And not baseline And not group Then Return
    If not panel.screens Then
        panel.screens = true
        SetDisplayState(panel.video, panel.cec, true)
    End If
    If wake Then Return
    panel.revision = ""
    panel.asset = ""
    panel.source = "built-in"
    panel.name = "Built-in presentation"
    path = panel.baseline
    If group Then
        revision = Mid(syncId, 12, 24)
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
    If not PlayNative(panel.video, path, event) Then panel.state = "error"
    RefreshOverlay(panel)
End Sub

Sub PanelVideoEvent(panel As Object, code As Integer)
    LogEvent("NATIVE_VIDEO_EVENT", {code: code})
    If panel.source = "web" Then Return
    If code = 3 And panel.state = "starting" Then panel.state = "playing"
    If code <> 8 Or (panel.state <> "playing" And panel.state <> "starting") Then Return
    If panel.source = "srt" Then
        panel.state = "ended"
        panel.error = "The SRT stream ended or disconnected."
    Else If panel.nativeLoop = "seamless" Then
        StopPanel(panel, false)
        LogEvent("SEAMLESS_MEDIA_ENDED", {})
    Else If panel.role <> "follower" And panel.settings.loop And panel.screens And panel.settings.intent = "auto" Then
        StartPanel(panel)
    Else
        StopPanel(panel, false)
    End If
End Sub

Sub PanelRestart(panel As Object)
    If panel.rebootAt = 0 Or UpTime(0) < panel.rebootAt Then Return
    panel.rebootAt = 0
    change = panel.change
    panel.change = ""
    If change = "role-or-ptp" Then
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
    If not TextValue(nextSettings.leader) Then Return "Invalid leader."
    If Len(nextSettings.leader) <> 1 Or Instr(1, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", nextSettings.leader) = 0 Then Return "Invalid leader."
    If nextSettings.role = "leader" And nextSettings.leader <> m.playerId Then Return "Select this player to act as leader."
    If nextSettings.role = "follower" And nextSettings.leader = m.playerId Then Return "Select a different player as leader."
    If not WholeNumber(nextSettings.domain) Or not WholeNumber(nextSettings.volume) Or not WholeNumber(nextSettings.interval) Then Return "Use whole numbers."
    If nextSettings.domain < 0 Or nextSettings.domain > 127 Or nextSettings.volume < 0 Or nextSettings.volume > 100 Then Return "Setting out of range."
    If not ValidPanelGroup(nextSettings.group) Or not ValidPanelRect(nextSettings.rect) Or not BooleanValue(nextSettings.muted) Then Return "Invalid group or video window."
    If nextSettings.output <> "3840x2160x50p" And nextSettings.output <> "1920x1080x50p" Then Return "Unsupported HDMI mode."
    If panel.scheduled And (MinuteOfDay(nextSettings.on) < 0 Or MinuteOfDay(nextSettings.off) <= MinuteOfDay(nextSettings.on)) Then Return "Invalid display schedule."
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
        nextSettings.selection = {kind: "built-in"}
        change = "role-or-ptp"
    Else If nextSettings.output <> old.output Then
        change = "video-mode"
    Else
        change = ""
    End If
    If not SavePanel(panel, nextSettings) Then Return "Settings could not be written."
    panel.settings = nextSettings
    If change <> "" Then
        panel.change = change
        panel.rebootAt = UpTime(0) + 3
        Return ""
    End If
    If not ApplyVolume(panel, nextSettings) Then Return "The player rejected the volume setting."
    If FormatJson(old.rect) <> FormatJson(nextSettings.rect) And panel.video <> invalid Then
        panel.video.SetRectangle(PanelBounds(panel, nextSettings.rect))
        If panel.base <> invalid And panel.source = "web" Then StartPanel(panel)
    End If
    If nextSettings.overlay <> old.overlay Then RefreshOverlay(panel)
    Return ""
End Function

Function PanelCommand(panel As Object, action As String, body As Object) As String
    If action = "probe" Then
        If VerifiedAsset(panel, body.asset) Then Return ""
        Return "The native file probe rejected this media."
    Else If action = "settings" Then
        Return PanelSet(panel, body)
    End If
    If not panel.ready Then Return "Native playback is still starting."
    If panel.change <> "" Then Return "The device is about to restart."
    If action = "colour" Then
        For Each key In ["brightness", "hue", "saturation"]
            If not WholeNumber(body[key]) Then Return "Video colour values must be whole numbers."
            If body[key] < -1000 Or body[key] > 1000 Then Return "Video colour value out of range."
        End For
        values = {Brightness: body.brightness, Hue: body.hue, Saturation: body.saturation}
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
    If not panel.screens Then Return "The display schedule is in standby."
    If action = "arm" Then
        If not panel.waiting Or panel.source <> "group" Or body.revision <> panel.revision Or panel.warmUntil > 0 Then Return "That revision is not waiting."
        panel.waiting = false
    Else If action = "source" Then
        panel.waiting = false
        If body.type = "web" And not PanelWebUrl(body.url) Then Return "Invalid webpage URL."
        If body.type = "srt" Then
            If not TextValue(body.url) Then Return "Invalid SRT URL."
            If Len(body.url) > 1024 Or Left(body.url, 6) <> "srt://" Then Return "Invalid SRT URL."
        Else If body.type <> "web" Then
            Return "Unsupported source."
        End If
        PanelSignal(panel, "suite-stop-")
        panel.source = body.type
        panel.name = "Webpage"
        If body.type = "srt" Then panel.name = "SRT stream"
        panel.asset = ""
        panel.revision = ""
        panel.url = body.url
    Else If action = "play" Then
        If panel.role = "follower" Then Return "The configured leader controls group playback."
        If body.type <> "built-in" And body.type <> "group" And body.type <> "preview" And body.type <> "local" Then Return "Unsupported source."
        If body.type = "group" And (not SafeHex(body.revision, 24) Or panel.role <> "leader") Then Return "Invalid group revision."
        If body.type <> "built-in" And not VerifiedAsset(panel, body.asset) Then Return "The native file probe rejected this media."
        panel.waiting = false
        If body.type = "preview" Or body.type = "local" Then PanelSignal(panel, "suite-stop-")
        panel.source = body.type
        panel.asset = ""
        panel.revision = ""
        panel.url = ""
        panel.name = "Built-in presentation"
        If body.type <> "built-in" Then
            panel.asset = body.asset
            panel.name = body.name
            If body.type = "group" Then panel.revision = body.revision
        End If
        If body.type <> "preview" Then panel.settings.selection = {kind: panel.source, asset: panel.asset, revision: panel.revision, name: panel.name}
    Else If action <> "restart" Or panel.waiting Or (panel.role = "follower" And panel.source <> "srt" And panel.source <> "web") Then
        Return "This player cannot perform that command."
    End If
    panel.settings.intent = "auto"
    panel.warmUntil = 0
    If not StartPanel(panel) Then Return panel.error
    If (action = "play" And body.type <> "preview") Or action = "restart" Then
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

Sub SetDisplayState(video As Object, cec As Dynamic, wake As Boolean)
    If wake Then
        If m.holding <> invalid Then m.holding.Show()
    Else
        video.StopClear()
        If m.holding <> invalid Then m.holding.Hide()
    End If
    If cec = invalid Then Return

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

Function ShowHolding(mode As Object, path As String) As Dynamic
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
    If not holding.SetDefaultMode(1) Or not holding.DisplayFile(path) Or not holding.Show() Then
        LogEvent("HOLDING_IMAGE_REJECTED", {path: path})
        Return invalid
    End If
    Return holding
End Function

Function ConfigureCardAudio(video As Object, leader As Boolean) As Boolean
    If leader Then
        audio = CreateObject("roAudioOutput", "hdmi")
        If audio <> invalid Then
            If video.SetPcmAudioOutputs(audio) Then Return true
        End If
    Else
        If video.SetVolume(0) Then Return true
    End If
    LogEvent("AUDIO_CONFIGURATION_REJECTED", {leader: leader})
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

Function WaitForAddress(network As Object, players As Object, port As Object) As String
    LogEvent("WAITING_FOR_ETH0", {})
    address = ""
    For attempt = 1 To 45
        current = network.GetCurrentConfig()
        If Type(current) = "roAssociativeArray" Then
            If TextValue(current.ip4_address) Then
                address = current.ip4_address
                If current.link = true And address <> "" And players[address] <> invalid Then Return address
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

Function StartLeaderCycle(manager As Object, video As Object, path As String, prefix As String, sequence As Integer) As Boolean
    syncId = prefix + Mid(StrI(sequence), 2)
    event = manager.Synchronize(syncId, 500)
    If event = invalid Then
        LogEvent("SYNC_SCHEDULE_FAILED", {sync_id: syncId})
        Return false
    End If
    Return PlayNative(video, path, event)
End Function

Function PlayNative(video As Object, path As String, event As Object) As Boolean
    params = {
        Filename: path
        SyncDomain: event.GetDomain()
        SyncId: event.GetId()
        SyncIsoTimestamp: event.GetIsoTimestamp()
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
    fields.version = "0.2.2"
    fields.event = eventName
    fields.player_id = m.playerId
    line = FormatJson(fields)
    Print line
    If m.systemLog <> invalid Then m.systemLog.SendLine(line)
End Sub
