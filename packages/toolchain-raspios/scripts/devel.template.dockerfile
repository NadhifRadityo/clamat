FROM <%- baseImage %>

<% for(const [key, value] of Object.entries(baseImageLabels).filter(([k, v]) => k.startsWith("ETAG_") && v != "")) { -%>
LABEL ETAG_<%- key.slice("ETAG_".length) %>="" %>
<% } -%>
<% for(const [key, value] of Object.entries(baseImageLabels).filter(([k, v]) => k.startsWith("ETAG_") && v != "")) { -%>
LABEL ETAG_BASE_<%- key.slice("ETAG_".length) %>=<%- value %>
<% } -%>
LABEL ETAG_TEMPLATE=<%- dockerfileTemplateEtag %>

SHELL ["/bin/bash", "-c"]
WORKDIR /root

RUN cp -r /etc/skel/. /root
RUN INITRD=No apt-get update && apt-get upgrade -y
RUN INITRD=No apt-get install llvm-19 clang-19 clangd-19 lld-19 lldb-19 -y
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
RUN source "/root/.nvm/nvm.sh" && nvm install 25.4.0

ENV NVM_DIR=/root/.nvm
ENV PATH=$NVM_DIR/versions/node/v25.4.0/bin:$PATH
