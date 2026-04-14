aws ses send-email \
  --region eu-central-1 \
  --from "noreply@nwords.live" \
  --destination ToAddresses=cremoni@gmail.com \
  --message "Subject={Data=halo},Body={Text={Data='hi there'}}"

