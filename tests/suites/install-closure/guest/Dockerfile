ARG MICA_BASE
FROM ${MICA_BASE} AS poolbase
ARG EMULATED=0
ENV DEBIAN_FRONTEND=noninteractive
ENV EMULATED=${EMULATED}
COPY dist /dist
COPY upstream /upstream
COPY in /in
RUN printf '%s\n' '#!/bin/sh' 'exit 101' >/usr/sbin/policy-rc.d && chmod 0755 /usr/sbin/policy-rc.d && mkdir -p /report

FROM poolbase AS full
RUN bash /in/assert-full.sh >/report/full.txt 2>&1; cat /report/full.txt

FROM poolbase AS declined-mqtt
RUN bash /in/assert-declined.sh >/report/declined.txt 2>&1; cat /report/declined.txt

FROM poolbase AS radio-wifi
RUN bash /in/assert-radio.sh mica-wifi "mica-wifi-ap mica-bluetooth" >/report/radio.txt 2>&1; cat /report/radio.txt

FROM poolbase AS radio-wifi-ap
RUN bash /in/assert-radio.sh mica-wifi-ap "mica-wifi mica-bluetooth" >/report/radio.txt 2>&1; cat /report/radio.txt

FROM poolbase AS radio-bluetooth
RUN bash /in/assert-radio.sh mica-bluetooth "mica-wifi mica-wifi-ap" >/report/radio.txt 2>&1; cat /report/radio.txt

FROM scratch AS reports
COPY --from=full /report/full.txt /full.txt
COPY --from=declined-mqtt /report/declined.txt /declined.txt
COPY --from=radio-wifi /report/radio.txt /radio-mica-wifi.txt
COPY --from=radio-wifi-ap /report/radio.txt /radio-mica-wifi-ap.txt
COPY --from=radio-bluetooth /report/radio.txt /radio-mica-bluetooth.txt
