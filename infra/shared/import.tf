locals {
  import_main = var.environment == "main" ? toset(["main"]) : toset([])
}

import {
  for_each = local.import_main
  to       = aws_route53_zone.main
  id       = "Z0749074TAIKLLRRH3OM"
}

import {
  for_each = local.import_main
  to       = aws_acm_certificate.main
  id       = "arn:aws:acm:us-east-1:870923192739:certificate/0d3d5281-0191-4dc4-845e-3cef467ffda7"
}

import {
  for_each = local.import_main
  to       = aws_iam_openid_connect_provider.github_actions
  id       = "arn:aws:iam::870923192739:oidc-provider/token.actions.githubusercontent.com"
}

import {
  for_each = local.import_main
  to       = aws_iam_role.github_actions_ci
  id       = "yaffle-github-actions-ci"
}

import {
  for_each = local.import_main
  to       = module.self_hosted_main_execution_role.aws_iam_role.yaffle_role
  id       = var.self_hosted_main_execution_role_name
}

import {
  for_each = local.import_main
  to       = module.self_hosted_main_execution_role.aws_iam_role_policy_attachment.managed[0]
  id       = "${var.self_hosted_main_execution_role_name}/arn:aws:iam::aws:policy/AdministratorAccess"
}

import {
  for_each = local.import_main
  to       = aws_iam_role_policy.github_actions_ci_ecr
  id       = "yaffle-github-actions-ci:ecr-push"
}

import {
  for_each = local.import_main
  to       = aws_iam_role_policy.github_actions_ci_s3
  id       = "yaffle-github-actions-ci:s3-state-access"
}

import {
  for_each = local.import_main
  to       = aws_route53_record.cert_validation["preview.yaffle.dev"]
  id       = "Z0749074TAIKLLRRH3OM__ce44d2fbaed24a13f62c31cd912dcffc.preview.yaffle.dev._CNAME"
}

import {
  for_each = local.import_main
  to       = aws_route53_record.cert_validation["yaffle.dev"]
  id       = "Z0749074TAIKLLRRH3OM__33bf6621a2a87cbf317e2603ffee0dc2.yaffle.dev._CNAME"
}

import {
  for_each = local.import_main
  to       = aws_route53_record.loops_mx
  id       = "Z0749074TAIKLLRRH3OM_envelope.m.yaffle.dev_MX"
}

import {
  for_each = local.import_main
  to       = aws_route53_record.loops_spf
  id       = "Z0749074TAIKLLRRH3OM_envelope.m.yaffle.dev_TXT"
}

import {
  for_each = local.import_main
  to       = aws_route53_record.loops_dmarc
  id       = "Z0749074TAIKLLRRH3OM__dmarc.m.yaffle.dev_TXT"
}

import {
  for_each = local.import_main
  to       = aws_route53_record.loops_dkim["h2rr6erlq2pij3snyaswwqredwgsx4bs"]
  id       = "Z0749074TAIKLLRRH3OM_h2rr6erlq2pij3snyaswwqredwgsx4bs._domainkey.m.yaffle.dev_CNAME"
}

import {
  for_each = local.import_main
  to       = aws_route53_record.loops_dkim["tpcry2ehdqyxgw73tumgtcboxnmd34ax"]
  id       = "Z0749074TAIKLLRRH3OM_tpcry2ehdqyxgw73tumgtcboxnmd34ax._domainkey.m.yaffle.dev_CNAME"
}

import {
  for_each = local.import_main
  to       = aws_route53_record.loops_dkim["wbae33kfygociw2z3n3rnexdyafr66hc"]
  id       = "Z0749074TAIKLLRRH3OM_wbae33kfygociw2z3n3rnexdyafr66hc._domainkey.m.yaffle.dev_CNAME"
}

import {
  for_each = local.import_main
  to       = aws_route53_record.fastmail_mx
  id       = "Z0749074TAIKLLRRH3OM_yaffle.dev_MX"
}

import {
  for_each = local.import_main
  to       = aws_route53_record.fastmail_mx_wildcard
  id       = "Z0749074TAIKLLRRH3OM_*.yaffle.dev_MX"
}

import {
  for_each = local.import_main
  to       = aws_route53_record.fastmail_mx_mail
  id       = "Z0749074TAIKLLRRH3OM_mail.yaffle.dev_MX"
}

import {
  for_each = local.import_main
  to       = aws_route53_record.fastmail_a_mail
  id       = "Z0749074TAIKLLRRH3OM_mail.yaffle.dev_A"
}

import {
  for_each = local.import_main
  to       = aws_route53_record.fastmail_spf
  id       = "Z0749074TAIKLLRRH3OM_yaffle.dev_TXT"
}

import {
  for_each = local.import_main
  to       = aws_route53_record.fastmail_dmarc
  id       = "Z0749074TAIKLLRRH3OM__dmarc.yaffle.dev_TXT"
}

import {
  for_each = local.import_main
  to       = aws_route53_record.fastmail_dkim["fm1"]
  id       = "Z0749074TAIKLLRRH3OM_fm1._domainkey.yaffle.dev_CNAME"
}

import {
  for_each = local.import_main
  to       = aws_route53_record.fastmail_dkim["fm2"]
  id       = "Z0749074TAIKLLRRH3OM_fm2._domainkey.yaffle.dev_CNAME"
}

import {
  for_each = local.import_main
  to       = aws_route53_record.fastmail_dkim["fm3"]
  id       = "Z0749074TAIKLLRRH3OM_fm3._domainkey.yaffle.dev_CNAME"
}

import {
  for_each = local.import_main
  to       = aws_route53_record.fastmail_dkim["mesmtp"]
  id       = "Z0749074TAIKLLRRH3OM_mesmtp._domainkey.yaffle.dev_CNAME"
}

import {
  for_each = local.import_main
  to       = aws_route53_record.fastmail_srv["_autodiscover._tcp"]
  id       = "Z0749074TAIKLLRRH3OM__autodiscover._tcp.yaffle.dev_SRV"
}

import {
  for_each = local.import_main
  to       = aws_route53_record.fastmail_srv["_caldav._tcp"]
  id       = "Z0749074TAIKLLRRH3OM__caldav._tcp.yaffle.dev_SRV"
}

import {
  for_each = local.import_main
  to       = aws_route53_record.fastmail_srv["_caldavs._tcp"]
  id       = "Z0749074TAIKLLRRH3OM__caldavs._tcp.yaffle.dev_SRV"
}

import {
  for_each = local.import_main
  to       = aws_route53_record.fastmail_srv["_carddav._tcp"]
  id       = "Z0749074TAIKLLRRH3OM__carddav._tcp.yaffle.dev_SRV"
}

import {
  for_each = local.import_main
  to       = aws_route53_record.fastmail_srv["_carddavs._tcp"]
  id       = "Z0749074TAIKLLRRH3OM__carddavs._tcp.yaffle.dev_SRV"
}

import {
  for_each = local.import_main
  to       = aws_route53_record.fastmail_srv["_imap._tcp"]
  id       = "Z0749074TAIKLLRRH3OM__imap._tcp.yaffle.dev_SRV"
}

import {
  for_each = local.import_main
  to       = aws_route53_record.fastmail_srv["_imaps._tcp"]
  id       = "Z0749074TAIKLLRRH3OM__imaps._tcp.yaffle.dev_SRV"
}

import {
  for_each = local.import_main
  to       = aws_route53_record.fastmail_srv["_jmap._tcp"]
  id       = "Z0749074TAIKLLRRH3OM__jmap._tcp.yaffle.dev_SRV"
}

import {
  for_each = local.import_main
  to       = aws_route53_record.fastmail_srv["_pop3._tcp"]
  id       = "Z0749074TAIKLLRRH3OM__pop3._tcp.yaffle.dev_SRV"
}

import {
  for_each = local.import_main
  to       = aws_route53_record.fastmail_srv["_pop3s._tcp"]
  id       = "Z0749074TAIKLLRRH3OM__pop3s._tcp.yaffle.dev_SRV"
}

import {
  for_each = local.import_main
  to       = aws_route53_record.fastmail_srv["_submission._tcp"]
  id       = "Z0749074TAIKLLRRH3OM__submission._tcp.yaffle.dev_SRV"
}

import {
  for_each = local.import_main
  to       = aws_route53_record.fastmail_srv["_submissions._tcp"]
  id       = "Z0749074TAIKLLRRH3OM__submissions._tcp.yaffle.dev_SRV"
}

import {
  for_each = local.import_main
  to       = aws_secretsmanager_secret.tailscale_runner_authkey
  id       = "arn:aws:secretsmanager:us-east-1:870923192739:secret:yaffle/shared/tailscale/runner-authkey-x86jEV"
}

import {
  for_each = local.import_main
  to       = aws_secretsmanager_secret_version.tailscale_runner_authkey
  id       = "arn:aws:secretsmanager:us-east-1:870923192739:secret:yaffle/shared/tailscale/runner-authkey-x86jEV|terraform-20260320031421095200000001"
}

import {
  for_each = local.import_main
  to       = aws_ssm_parameter.tailscale_layer_arn
  id       = "/yaffle/scanner/layers/tailscale"
}

import {
  for_each = local.import_main
  to       = tailscale_acl.policy
  id       = "ba998ec7-d1ed-73b3-55b1-c313bbca590b"
}

import {
  for_each = local.import_main
  to       = tailscale_oauth_client.ecs_runner
  id       = "kdaYfkkryj11CNTRL"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.cert_validation["preview.yaffle.dev"]
  id       = "${var.cloudflare_zone_id}/d91e9a7fd1b4d7f3d1e50f5660b5c4b7"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.cert_validation["yaffle.dev"]
  id       = "${var.cloudflare_zone_id}/9c0a65f776b20847183449332728f145"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.route53_ns[0]
  id       = "${var.cloudflare_zone_id}/784ec4fdb8f8d1f533b18105af2a7a0e"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.route53_ns[1]
  id       = "${var.cloudflare_zone_id}/834da0e2ce42de33d0dded5122ff81ee"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.route53_ns[2]
  id       = "${var.cloudflare_zone_id}/f66a81a104e7c6d93f16096445c4e883"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.route53_ns[3]
  id       = "${var.cloudflare_zone_id}/545406be3ac513f963d834f03d1718bc"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.loops_mx
  id       = "${var.cloudflare_zone_id}/c8f4fe007e4cd85eb4ed20e53a707ac1"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.loops_spf
  id       = "${var.cloudflare_zone_id}/025dcb379c935d70b86cd37125cd1b6f"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.loops_dmarc
  id       = "${var.cloudflare_zone_id}/e454ab1bc3af461469f61f999454f67e"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.loops_dkim["h2rr6erlq2pij3snyaswwqredwgsx4bs"]
  id       = "${var.cloudflare_zone_id}/1560529b436d7fae34f65a31a4753d5d"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.loops_dkim["tpcry2ehdqyxgw73tumgtcboxnmd34ax"]
  id       = "${var.cloudflare_zone_id}/52a6a961e7147f2d03e8d93724ac58fb"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.loops_dkim["wbae33kfygociw2z3n3rnexdyafr66hc"]
  id       = "${var.cloudflare_zone_id}/e8173867146ebe1b6427914ac703ec0c"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.fastmail_mx_primary
  id       = "${var.cloudflare_zone_id}/d0d2b6e2a331396c9355208b5d95e468"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.fastmail_mx_secondary
  id       = "${var.cloudflare_zone_id}/dc51d4406b90010a8439dfa98252560e"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.fastmail_mx_wildcard_primary
  id       = "${var.cloudflare_zone_id}/14d85451e6e9d338759535d494a598e7"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.fastmail_mx_wildcard_secondary
  id       = "${var.cloudflare_zone_id}/0045506782b3598c9b5aab9128faeb90"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.fastmail_mx_mail_primary
  id       = "${var.cloudflare_zone_id}/8f63eee308977f2959c4e5d8d46b9453"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.fastmail_mx_mail_secondary
  id       = "${var.cloudflare_zone_id}/2a210efca92b9408b4a5c24b1d479b41"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.fastmail_a_mail
  id       = "${var.cloudflare_zone_id}/1f0bf148f686e35a9f5616495416355f"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.fastmail_spf
  id       = "${var.cloudflare_zone_id}/e05a47511515a88465d833f1a6baca8c"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.fastmail_dmarc
  id       = "${var.cloudflare_zone_id}/0add7248f41c9232155e93478722a526"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.fastmail_dkim["fm1"]
  id       = "${var.cloudflare_zone_id}/573b74057b19407ebab185d7764262de"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.fastmail_dkim["fm2"]
  id       = "${var.cloudflare_zone_id}/89112f62f588bc76fa8b428de42c128e"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.fastmail_dkim["fm3"]
  id       = "${var.cloudflare_zone_id}/3beb5914e23c62fd6ef977eb4306f6f7"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.fastmail_dkim["mesmtp"]
  id       = "${var.cloudflare_zone_id}/b87791677bebf382977a671f430029f3"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.fastmail_srv["_autodiscover._tcp"]
  id       = "${var.cloudflare_zone_id}/26cfe28349e83d5ea96252119a4edd1d"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.fastmail_srv["_caldav._tcp"]
  id       = "${var.cloudflare_zone_id}/db3d6cb0ddb3acb7206295167f469ffe"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.fastmail_srv["_caldavs._tcp"]
  id       = "${var.cloudflare_zone_id}/4da38f15bc457f6c88289f9fe74c1628"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.fastmail_srv["_carddav._tcp"]
  id       = "${var.cloudflare_zone_id}/7f21be7ff57eae8ee6b72ad4b41bfa8b"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.fastmail_srv["_carddavs._tcp"]
  id       = "${var.cloudflare_zone_id}/b2d088e968daf2d0344f2bec8348f504"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.fastmail_srv["_imap._tcp"]
  id       = "${var.cloudflare_zone_id}/17d66d730ec5ddbded646a606d1b9b7f"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.fastmail_srv["_imaps._tcp"]
  id       = "${var.cloudflare_zone_id}/cb69fa00e020502e025a49042f62937b"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.fastmail_srv["_jmap._tcp"]
  id       = "${var.cloudflare_zone_id}/cfa7b16a8beb924fb87cb22a3f8b31ce"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.fastmail_srv["_pop3._tcp"]
  id       = "${var.cloudflare_zone_id}/29cfd3a5e7f03e7c6651ef34bda22d77"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.fastmail_srv["_pop3s._tcp"]
  id       = "${var.cloudflare_zone_id}/e07db02be11fa6061d5b0aecc3330aa5"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.fastmail_srv["_submission._tcp"]
  id       = "${var.cloudflare_zone_id}/ddec4ba9c581c27e7cc1535932f78539"
}

import {
  for_each = local.import_main
  to       = cloudflare_dns_record.fastmail_srv["_submissions._tcp"]
  id       = "${var.cloudflare_zone_id}/bbaf1acdc9e328299eb88baef748f029"
}
