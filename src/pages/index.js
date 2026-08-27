import React from "react";
import Layout from "@theme/Layout";
import Link from "@docusaurus/Link";
import manuals from "@site/docs/manuals.json";

export default function Home() {
  return (
    <Layout title="Manuals">
      <main style={{ maxWidth: 860, margin: "0 auto", padding: "2rem 1rem" }}>
        <h1>Simulator manuals</h1>
        <p>Each manual is generated from the configuration file of one device and describes only the components installed on it.</p>
        <table>
          <thead><tr><th>Serial</th><th>Issue.Rev</th><th>Pages</th><th></th></tr></thead>
          <tbody>
            {manuals.map(m => (
              <tr key={m.slug}>
                <td>{m.serial}</td><td>{m.issueRev}</td><td>{m.pages}</td>
                <td><Link to={`/manuals/${m.slug}/`}>Open</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </main>
    </Layout>
  );
}
