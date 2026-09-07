; trAIMer — NSIS customisation.
;
; Uninstall must remove the application cleanly while PRESERVING training
; history and settings, unless the player explicitly asks for them to go.
; Everything the app persists (IndexedDB training data, diagnostics logs)
; lives under %APPDATA%\trAIMer, which electron-builder leaves alone by
; default (deleteAppDataOnUninstall: false). This macro adds the explicit
; opt-in for players who really do want a clean slate.
;
; %APPDATA%\AldoAimLab is the pre-rename directory (builds up to 1.0.0-rc.6).
; The shell moves it to %APPDATA%\trAIMer on first launch, but a machine that
; installed rc.7 and never launched it still has the old folder, so "delete my
; data" has to clear both or it would leave the player's history behind after
; they explicitly asked for it to go.
;
; /SD IDNO makes the SILENT answer "keep my data", so an automated or
; upgrade-driven uninstall can never delete a player's sessions.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "Also delete your trAIMer training history, calibration and settings?$\r$\n$\r$\nChoose No to keep them for a future reinstall." \
      /SD IDNO IDYES traimerDeleteUserData IDNO traimerKeepUserData
    traimerDeleteUserData:
      RMDir /r "$APPDATA\trAIMer"
      RMDir /r "$APPDATA\AldoAimLab"
      DetailPrint "Removed trAIMer user data."
      Goto traimerUserDataDone
    traimerKeepUserData:
      DetailPrint "Kept trAIMer user data in $APPDATA\trAIMer."
    traimerUserDataDone:
  ${endIf}
!macroend
