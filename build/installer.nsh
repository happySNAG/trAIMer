; Aldo Aim Lab — NSIS customisation.
;
; Uninstall must remove the application cleanly while PRESERVING training
; history and settings, unless the player explicitly asks for them to go.
; Everything the app persists (IndexedDB training data, diagnostics logs)
; lives under %APPDATA%\AldoAimLab, which electron-builder leaves alone by
; default (deleteAppDataOnUninstall: false). This macro adds the explicit
; opt-in for players who really do want a clean slate.
;
; /SD IDNO makes the SILENT answer "keep my data", so an automated or
; upgrade-driven uninstall can never delete a player's sessions.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "Also delete your Aldo Aim Lab training history, calibration and settings?$\r$\n$\r$\nChoose No to keep them for a future reinstall." \
      /SD IDNO IDYES aldoDeleteUserData IDNO aldoKeepUserData
    aldoDeleteUserData:
      RMDir /r "$APPDATA\AldoAimLab"
      DetailPrint "Removed Aldo Aim Lab user data."
      Goto aldoUserDataDone
    aldoKeepUserData:
      DetailPrint "Kept Aldo Aim Lab user data in $APPDATA\AldoAimLab."
    aldoUserDataDone:
  ${endIf}
!macroend
