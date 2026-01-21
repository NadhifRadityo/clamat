FROM <%- baseImage %>
<% for(const baseImageEtagKey of Object.keys(baseImageLabels).filter(k => k.startsWith("ETAG_"))) { %>
LABEL ETAG_BASE_<%- baseImageEtagKey.slice("ETAG_".length) %>=<%- baseImageLabels[baseImageEtagKey] %>
<% } %>
LABEL ETAG_TEMPLATE=<%- dockerfileTemplateEtag %>

SHELL ["/bin/bash", "-c"]
WORKDIR /root

RUN cp -r /etc/skel/. /root
RUN INITRD=No apt-get update && apt-get upgrade -y
RUN INITRD=No apt-get install llvm-19 clang-19 clangd-19 lld-19 lldb-19 -y
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
RUN source "/root/.nvm/nvm.sh" && nvm install 25.4.0
RUN mkdir -p /mnt/data

VOLUME /mnt/data
