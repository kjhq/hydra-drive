!macro customUnInstall
  ${ifNot} ${isUpdated}
    RMDir /r "$LOCALAPPDATA\hydra-drive-updater"
  ${endIf}
!macroend
