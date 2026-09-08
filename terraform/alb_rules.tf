resource "aws_lb_target_group" "app" {
  name        = "${var.project_name}-${var.environment}-tg"
  port        = var.app_port
  protocol    = "HTTP"
  vpc_id      = data.terraform_remote_state.shared.outputs.vpc_id
  target_type = "ip"

  health_check {
    enabled             = true
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
    path                = var.health_check_path
    matcher             = "200"
    protocol            = "HTTP"
    port                = "traffic-port"
  }

  deregistration_delay = 30
}

resource "aws_lb_listener_rule" "app" {
  listener_arn = data.terraform_remote_state.shared.outputs.https_listener_arn
  priority     = var.alb_listener_rule_priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }

  condition {
    host_header {
      values = [local.app_hostname]
    }
  }
}

resource "aws_lb_listener_certificate" "app" {
  listener_arn    = data.terraform_remote_state.shared.outputs.https_listener_arn
  certificate_arn = var.alb_certificate_arn
}
