import * as React from "react";
import Frame from "../components/Frame";
import { EmbedProps as Props } from ".";

function Nextcloud(props: Props) {
  const { matches } = props.attrs;
  const source = matches[0];
  return <Frame {...props} src={source} title="Nextcloud" />;
}

Nextcloud.ENABLED = [
    new RegExp("^https://.*\.nextcloud\.com/?(.*)$"),
];
Nextcloud.URL_PATH_REGEX = /(.+)/;

export default Nextcloud;
