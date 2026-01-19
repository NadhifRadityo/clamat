FROM <%- baseImage %>
<% for(let i = 0; i < baseImageEtags.length; i++) { %>
LABEL ETAG_<%- i %>=<%- baseImageEtags[i] %>
<% } %>

SHELL ["/bin/bash", "-c"]

RUN cp -r /etc/skel/. /root
RUN apt-get update && apt-get upgrade -y
RUN apt-get install llvm-19 clang-19 clangd-19 lld-19 lldb-19 -y
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
RUN source "/root/.nvm/nvm.sh" && nvm install 25.4.0
RUN mkdir -p /mnt/data

VOLUME /mnt/data
