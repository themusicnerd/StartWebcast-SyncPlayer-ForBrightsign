Sub Main()
    m.root = GetDefaultDrive()
    m.bootReport = ""
    BootNote("StartWebcast SyncPlayer card boot")
    port = CreateObject("roMessagePort")
    StartCard(port)
    While true
        Wait(0, port)
    End While
End Sub

Sub StartCard(port As Object)
    BootNote("Read device and card configuration")
    device = CreateObject("roDeviceInfo")
    If device = invalid Then
        BootNote("DEVICE_INFO_UNAVAILABLE")
        Return
    End If
    model = device.GetModel()
    BootNote("Model " + model + ", BrightSignOS " + device.GetVersion())
    If UCase(model) <> "XD236" Then
        BootNote("UNSUPPORTED_MODEL")
        Return
    End If

    config = ParseJson(ReadAsciiFile(m.root + "syncplayer.json"))
    If Type(config) <> "roAssociativeArray" Then
        BootNote("INVALID_CARD_CONFIG")
        Return
    End If
    If Type(config.players) <> "roAssociativeArray" Or not BootText(config.card_player_id) Then
        BootNote("INVALID_CARD_ASSIGNMENT")
        Return
    End If
    BootNote("Player card " + config.card_player_id)

    If config.static_ipv4 <> invalid Then
        If not ValidStaticIPv4(config.static_ipv4, config.players, config.card_player_id) Then
            BootNote("INVALID_STATIC_IPV4")
            Return
        End If
    End If

    ' Start diagnostics at the currently reachable address before attempting an address change.
    If EnableCardDiagnostics() Then
        BootNote("Restarting to start local diagnostics")
        RebootSystem()
        Return
    End If

    If config.static_ipv4 <> invalid Then
        network = CreateObject("roNetworkConfiguration", 0)
        If network = invalid Then
            BootNote("REAR_ETHERNET_UNAVAILABLE")
            Return
        End If
        If not ProvisionStaticIPv4(network, config.static_ipv4, port) Then
            BootNote("Playback waits for the card address. See network-setup.txt.")
            Return
        End If
    End If
    slot = SelectUpdateSlot()
    RunCardSlot(slot)
    If slot <> "base" Then RunCardSlot("base")
End Sub

Function UsableUpdateSlot(slot As Dynamic) As Boolean
    If not BootText(slot) Then Return false
    If Len(slot) < 5 Or Len(slot) > 14 Then Return false
    dots = 0
    digits = 0
    startsWithZero = false
    For i = 1 To Len(slot)
        char = Mid(slot, i, 1)
        If char = "." Then
            If digits = 0 Or dots = 2 Then Return false
            dots = dots + 1
            digits = 0
        Else
            If Instr(1, "0123456789", char) = 0 Or digits = 4 Then Return false
            If digits = 0 Then
                startsWithZero = char = "0"
            Else If startsWithZero Then
                Return false
            End If
            digits = digits + 1
        End If
    End For
    If dots <> 2 Or digits = 0 Then Return false
    root = m.root + "updates/slots/" + slot + "/"
    Return ReadAsciiFile(root + "package.json") <> "" And ReadAsciiFile(root + "VERSION").Trim() = slot
End Function

Function SelectUpdateSlot() As String
    state = ParseJson(ReadAsciiFile(m.root + "updates/active.json"))
    If Type(state) <> "roAssociativeArray" Then Return "base"
    If state.slot = "base" Then Return "base"
    If UsableUpdateSlot(state.slot) Then
        root = m.root + "updates/slots/" + state.slot + "/"
        If ReadAsciiFile(root + "healthy.txt") = "yes" Then Return state.slot
        If ReadAsciiFile(root + "attempt.txt") = "" Then
            If WriteAsciiFile(root + "attempt.txt", "yes") Then Return state.slot
        End If
        BootNote("UPDATE_BOOT_FALLBACK " + state.slot)
    End If
    If UsableUpdateSlot(state.previous) Then
        If ReadAsciiFile(m.root + "updates/slots/" + state.previous + "/healthy.txt") = "yes" Then Return state.previous
    End If
    Return "base"
End Function

Sub RunCardSlot(slot As String)
    runtime = m.root
    If slot <> "base" Then runtime = m.root + "updates/slots/" + slot + "/"
    If not WriteAsciiFile(m.root + "suite-launch.txt", slot) And slot <> "base" Then Return
    BootNote("Loading playback.brs from " + slot)
    Run(runtime + "playback.brs")
    compileErrors = GetLastRunCompileError()
    If compileErrors <> invalid Then
        For Each detail In compileErrors
            BootNote("Playback compile error, line " + StrI(detail.errln) + ": " + Left(detail.errstr, 300))
        End For
    Else
        BootNote("Playback returned with BrightScript status" + StrI(GetLastRunRuntimeError()))
    End If
End Sub

Function EnableCardDiagnostics() As Boolean
    registry = CreateObject("roRegistrySection", "networking")
    If registry = invalid Then
        BootNote("DWS_REGISTRY_UNAVAILABLE")
        Return false
    End If
    If LCase(registry.Read("dwse")) = "yes" Then
        BootNote("Local diagnostics are enabled")
        Return false
    End If

    password = TrimCardPassword(ReadAsciiFile(m.root + "dws-password.txt"))
    If password = "" Then
        BootNote("Local diagnostics await a password file")
        Return false
    End If
    If not ValidCardPassword(password) Then
        BootNote("DWS_PASSWORD_REQUIREMENTS_NOT_MET")
        Return false
    End If

    network = CreateObject("roNetworkConfiguration", 0)
    If network = invalid Then
        BootNote("DWS_NETWORK_UNAVAILABLE")
        Return false
    End If
    BootNote("Configure password-protected local diagnostics")
    needsRestart = network.SetupDWS({port: 80, open: password, basic: false})
    If not needsRestart And network.GetFailureReason() <> "" Then
        BootNote("DWS_SETUP_REJECTED")
        Return false
    End If
    If not network.Apply() Then
        BootNote("DWS_APPLY_FAILED")
        Return false
    End If
    If not registry.Write("dwse", "yes") Or not registry.Flush() Then
        BootNote("DWS_ENABLE_FAILED")
        Return false
    End If
    Return true
End Function

Function TrimCardPassword(value As String) As String
    While Len(value) > 0
        lastCode = Asc(Right(value, 1))
        If lastCode <> 10 And lastCode <> 13 Then Exit While
        value = Left(value, Len(value) - 1)
    End While
    Return value
End Function

Function ValidCardPassword(value As String) As Boolean
    If Len(value) < 8 Or Len(value) > 128 Then Return false
    upper = false
    lower = false
    digit = false
    special = false
    For index = 1 To Len(value)
        code = Asc(Mid(value, index, 1))
        If code < 33 Or code > 126 Then Return false
        If code >= 65 And code <= 90 Then
            upper = true
        Else If code >= 97 And code <= 122 Then
            lower = true
        Else If code >= 48 And code <= 57 Then
            digit = true
        Else
            special = true
        End If
    End For
    Return upper And lower And digit And special
End Function

Sub BootNote(message As String)
    If Len(m.bootReport) < 8192 Then
        m.bootReport = m.bootReport + message + Chr(13) + Chr(10)
        WriteAsciiFile(m.root + "boot-report.txt", m.bootReport)
    End If
    Print message
End Sub

Function BootText(value As Dynamic) As Boolean
    kind = Type(value)
    Return kind = "String" Or kind = "roString"
End Function

Function ValidStaticIPv4(profile As Dynamic, players As Object, cardId As String) As Boolean
    If Type(profile) <> "roAssociativeArray" Then Return false
    If not BootText(profile.address) Or not BootText(profile.broadcast) Or not BootText(profile.netmask) Then Return false
    If profile.netmask <> "255.255.255.0" Or players[profile.address] <> cardId Then Return false
    dot = Instr(1, profile.address, ".")
    For index = 1 To 2
        If dot = 0 Then Return false
        dot = Instr(dot + 1, profile.address, ".")
    End For
    If dot = 0 Then Return false
    octet = Mid(profile.address, dot + 1)
    hostNumber = StrToI(octet)
    If hostNumber < 1 Or hostNumber > 254 Or Mid(StrI(hostNumber), 2) <> octet Then Return false
    Return profile.broadcast = Left(profile.address, dot) + "255"
End Function

Function ProvisionStaticIPv4(network As Object, profile As Object, port As Object) As Boolean
    registry = CreateObject("roRegistrySection", "StartSyncPlayer")
    If registry = invalid Then
        RecordStaticStatus("STATIC_IPV4_REGISTRY_UNAVAILABLE", profile.address)
        Return false
    End If
    signature = profile.address + "/" + profile.netmask
    If registry.Read("static_eth0") = signature Then Return true

    If not MatchesStaticIPv4(network.GetCurrentConfig(), profile) Then
        RecordStaticStatus("STATIC_IPV4_APPLYING", profile.address)
        If not ApplyStaticIPv4(network, profile) Then
            RecordStaticStatus("STATIC_IPV4_APPLY_FAILED", profile.address)
            BootNote(Left(network.GetFailureReason(), 300))
            Return false
        End If
        For attempt = 1 To 30
            If MatchesStaticIPv4(network.GetCurrentConfig(), profile) Then Exit For
            Wait(1000, port)
        End For
        If not MatchesStaticIPv4(network.GetCurrentConfig(), profile) Then
            RecordStaticStatus("STATIC_IPV4_NOT_CONFIRMED", profile.address)
            Return false
        End If
    End If
    If not registry.Write("static_eth0", signature) Or not registry.Flush() Then
        RecordStaticStatus("STATIC_IPV4_MARKER_FAILED", profile.address)
        Return false
    End If
    RecordStaticStatus("STATIC_IPV4_READY", profile.address)
    Return true
End Function

Function ApplyStaticIPv4(network As Object, profile As Object) As Boolean
    If not network.SetIP4Address(profile.address) Then Return false
    If not network.SetIP4Netmask(profile.netmask) Then Return false
    If not network.SetIP4Broadcast(profile.broadcast) Then Return false
    Return network.Apply()
End Function

Function MatchesStaticIPv4(current As Dynamic, profile As Object) As Boolean
    If Type(current) <> "roAssociativeArray" Then Return false
    Return current.dhcp = false And current.ip4_address = profile.address And current.ip4_netmask = profile.netmask
End Function

Sub RecordStaticStatus(status As String, address As String)
    BootNote(status + " " + address)
    WriteAsciiFile(m.root + "network-setup.txt", status + " " + address + Chr(13) + Chr(10))
End Sub
